import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { CODEX_DEFAULT_INSTRUCTIONS } from "open-sse/config/codexInstructions.js";
import {
  CODEX_INSTRUCTIONS_FILENAME,
  CODEX_INSTRUCTIONS_FILE_PATH,
  deleteCustomCodexInstructionsFile,
  normalizeCodexInstructionsSettings,
  readCustomCodexInstructionsFile,
  writeCustomCodexInstructionsFile,
} from "open-sse/config/codexInstructionsResolver.js";

const MAX_CUSTOM_INSTRUCTIONS_BYTES = 200 * 1024; // 200 KB safety cap

function buildPayload() {
  return getSettings().then((settings) => {
    const cfg = normalizeCodexInstructionsSettings(settings?.codexInstructions);
    const customContent = readCustomCodexInstructionsFile();
    const hasCustomFile = customContent !== null;

    let effectiveContent;
    if (!cfg.enabled) {
      effectiveContent = "";
    } else if (cfg.mode === "custom" && hasCustomFile && customContent.length > 0) {
      effectiveContent = customContent;
    } else {
      effectiveContent = CODEX_DEFAULT_INSTRUCTIONS;
    }

    return {
      enabled: cfg.enabled,
      mode: cfg.mode,
      hasCustomFile,
      customContent: customContent ?? "",
      customLength: customContent ? customContent.length : 0,
      effectiveContent,
      effectiveLength: effectiveContent.length,
      defaultContent: CODEX_DEFAULT_INSTRUCTIONS,
      defaultLength: CODEX_DEFAULT_INSTRUCTIONS.length,
      filename: CODEX_INSTRUCTIONS_FILENAME,
      filePath: CODEX_INSTRUCTIONS_FILE_PATH,
      maxBytes: MAX_CUSTOM_INSTRUCTIONS_BYTES,
    };
  });
}

export async function GET() {
  try {
    const payload = await buildPayload();
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to read Codex instructions settings", message: error?.message || String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // 1. Resolve settings update.
  const currentSettings = await getSettings();
  const currentCfg = normalizeCodexInstructionsSettings(currentSettings?.codexInstructions);

  const next = { ...currentCfg };
  if (typeof body.enabled === "boolean") {
    next.enabled = body.enabled;
  }
  if (body.mode === "default" || body.mode === "custom") {
    next.mode = body.mode;
  }

  // 2. Resolve file changes.
  let fileMutation = null; // "write" | "delete" | null
  let writeContent = null;

  if (body.reset === true) {
    fileMutation = "delete";
    next.mode = "default";
  } else if (typeof body.content === "string") {
    if (Buffer.byteLength(body.content, "utf8") > MAX_CUSTOM_INSTRUCTIONS_BYTES) {
      return NextResponse.json(
        { error: `Custom instructions exceed ${MAX_CUSTOM_INSTRUCTIONS_BYTES} bytes` },
        { status: 400 },
      );
    }
    if (body.content.length === 0) {
      // Empty content -> treat as reset to default mode.
      fileMutation = "delete";
      next.mode = "default";
    } else {
      fileMutation = "write";
      writeContent = body.content;
      // Saving custom content implies switching to custom mode unless explicitly told otherwise.
      if (body.mode !== "default") {
        next.mode = "custom";
      }
    }
  }

  try {
    if (fileMutation === "write" && writeContent !== null) {
      writeCustomCodexInstructionsFile(writeContent);
    } else if (fileMutation === "delete") {
      deleteCustomCodexInstructionsFile();
    }
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to update custom instructions file", message: error?.message || String(error) },
      { status: 500 },
    );
  }

  await updateSettings({ codexInstructions: { enabled: next.enabled, mode: next.mode } });

  const payload = await buildPayload();
  return NextResponse.json(payload);
}
