import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { COMMANDCODE_DEFAULT_INSTRUCTIONS } from "open-sse/config/commandcodeInstructions.js";
import {
  COMMANDCODE_INSTRUCTIONS_FILENAME,
  deleteCustomCommandCodeInstructionsFile,
  normalizeCommandCodeInstructionsSettings,
  readCustomCommandCodeInstructionsFile,
  writeCustomCommandCodeInstructionsFile,
} from "open-sse/config/commandcodeInstructionsResolver.js";

const MAX_CUSTOM_INSTRUCTIONS_BYTES = 200 * 1024;

async function buildPayload() {
  const settings = await getSettings();
  const cfg = normalizeCommandCodeInstructionsSettings(settings?.commandcodeInstructions);
  const customContent = await readCustomCommandCodeInstructionsFile();
  const hasCustomFile = customContent !== null;

  let effectiveContent;
  if (!cfg.enabled) {
    effectiveContent = "";
  } else if (cfg.mode === "custom" && hasCustomFile && customContent.length > 0) {
    effectiveContent = customContent;
  } else {
    effectiveContent = COMMANDCODE_DEFAULT_INSTRUCTIONS;
  }

  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    hasCustomFile,
    customContent: customContent ?? "",
    customLength: customContent ? customContent.length : 0,
    effectiveContent,
    effectiveLength: effectiveContent.length,
    defaultContent: COMMANDCODE_DEFAULT_INSTRUCTIONS,
    defaultLength: COMMANDCODE_DEFAULT_INSTRUCTIONS.length,
    filename: COMMANDCODE_INSTRUCTIONS_FILENAME,
    filePath: COMMANDCODE_INSTRUCTIONS_FILENAME,
    maxBytes: MAX_CUSTOM_INSTRUCTIONS_BYTES,
  };
}

export async function GET() {
  try {
    const payload = await buildPayload();
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to read Command Code instructions settings", message: error?.message || String(error) },
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

  const currentSettings = await getSettings();
  const currentCfg = normalizeCommandCodeInstructionsSettings(currentSettings?.commandcodeInstructions);

  const next = { ...currentCfg };
  if (typeof body.enabled === "boolean") {
    next.enabled = body.enabled;
  }
  if (body.mode === "default" || body.mode === "custom") {
    next.mode = body.mode;
  }

  let fileMutation = null;
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
      fileMutation = "delete";
      next.mode = "default";
    } else {
      fileMutation = "write";
      writeContent = body.content;
      if (body.mode !== "default") {
        next.mode = "custom";
      }
    }
  }

  try {
    if (fileMutation === "write" && writeContent !== null) {
      await writeCustomCommandCodeInstructionsFile(writeContent);
    } else if (fileMutation === "delete") {
      await deleteCustomCommandCodeInstructionsFile();
    }
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to update custom instructions file", message: error?.message || String(error) },
      { status: 500 },
    );
  }

  await updateSettings({ commandcodeInstructions: { enabled: next.enabled, mode: next.mode } });

  const payload = await buildPayload();
  return NextResponse.json(payload);
}
