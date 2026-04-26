// Codex default instructions resolver.
//
// User-controlled, three-state behavior for the `instructions` field on Codex
// requests. Configured per-installation via dashboard provider settings:
//
//   1. enabled + mode="default"   -> built-in CODEX_DEFAULT_INSTRUCTIONS
//   2. enabled + mode="custom"    -> contents of DATA_DIR/codex-instructions.md
//   3. disabled                   -> empty string (saves ~3000 tokens / request,
//                                    backend uses its own server-side default)
//
// State 3 matches CLIProxyAPI's `instructions: ""` behavior. State 1 is the
// historical 9router-plus behavior and remains the default for back-compat.

import fs from "fs";
import path from "path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { getSettings } from "@/lib/localDb.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "./codexInstructions.js";

export const CODEX_INSTRUCTIONS_FILENAME = "codex-instructions.md";
export const CODEX_INSTRUCTIONS_FILE_PATH = path.join(DATA_DIR, CODEX_INSTRUCTIONS_FILENAME);

const DEFAULT_SETTINGS = Object.freeze({ enabled: true, mode: "default" });

// Normalize a settings.codexInstructions object into a known shape.
export function normalizeCodexInstructionsSettings(raw) {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const enabled = raw.enabled !== false; // default true
  const mode = raw.mode === "custom" ? "custom" : "default";
  return { enabled, mode };
}

// Read the user's custom instructions .md file, or null if absent / unreadable.
export function readCustomCodexInstructionsFile() {
  try {
    if (!fs.existsSync(CODEX_INSTRUCTIONS_FILE_PATH)) return null;
    const content = fs.readFileSync(CODEX_INSTRUCTIONS_FILE_PATH, "utf-8");
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}

// Write the user's custom instructions .md file. Creates parent dir as needed.
export function writeCustomCodexInstructionsFile(content) {
  const text = typeof content === "string" ? content : "";
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(CODEX_INSTRUCTIONS_FILE_PATH, text, "utf-8");
}

// Delete the user's custom instructions .md file. No-op if absent.
export function deleteCustomCodexInstructionsFile() {
  try {
    if (fs.existsSync(CODEX_INSTRUCTIONS_FILE_PATH)) {
      fs.unlinkSync(CODEX_INSTRUCTIONS_FILE_PATH);
    }
  } catch {
    // Best-effort.
  }
}

// Resolve the instructions string for a Codex request given the current
// codexInstructions settings and (optional) custom file contents.
export function resolveCodexInstructionsFromConfig(rawSettings, customContent) {
  const { enabled, mode } = normalizeCodexInstructionsSettings(rawSettings);
  if (!enabled) return "";
  if (mode === "custom") {
    if (typeof customContent === "string" && customContent.length > 0) {
      return customContent;
    }
    // Custom mode selected but no usable file content -> fall back to default
    // so requests continue to receive a meaningful prompt.
    return CODEX_DEFAULT_INSTRUCTIONS;
  }
  return CODEX_DEFAULT_INSTRUCTIONS;
}

// Async helper used by the executor: read settings (cached) + custom file and
// return the resolved instructions string for the next outbound Codex request.
export async function resolveCodexInstructionsForRequest() {
  let raw = null;
  try {
    const settings = await getSettings();
    raw = settings?.codexInstructions || null;
  } catch {
    // Fall through: use defaults.
  }
  const { enabled, mode } = normalizeCodexInstructionsSettings(raw);
  if (!enabled) return "";
  if (mode === "custom") {
    const custom = readCustomCodexInstructionsFile();
    if (typeof custom === "string" && custom.length > 0) return custom;
    return CODEX_DEFAULT_INSTRUCTIONS;
  }
  return CODEX_DEFAULT_INSTRUCTIONS;
}
