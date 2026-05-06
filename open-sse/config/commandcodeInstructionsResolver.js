import { COMMANDCODE_DEFAULT_INSTRUCTIONS } from "./commandcodeInstructions.js";

export const COMMANDCODE_INSTRUCTIONS_FILENAME = "commandcode-instructions.md";

const DEFAULT_SETTINGS = Object.freeze({ enabled: true, mode: "default" });

function isWorkerRuntime() {
  return (
    typeof WebSocketPair !== "undefined" || typeof EdgeRuntime !== "undefined"
  );
}

async function importDataDirModule() {
  try {
    return await import("@/lib/dataDir.js");
  } catch {
    try {
      return await import("../../src/lib/dataDir.js");
    } catch {
      return null;
    }
  }
}

async function importLocalDbModule() {
  try {
    return await import("@/lib/localDb.js");
  } catch {
    try {
      return await import("../../src/lib/localDb.js");
    } catch {
      return null;
    }
  }
}

async function loadNodeHelpers() {
  try {
    const [{ default: fs }, { default: path }, dataDirModule] =
      await Promise.all([
        import("fs"),
        import("path"),
        importDataDirModule(),
      ]);
    const dataDir = dataDirModule?.DATA_DIR;
    if (!dataDir) return null;

    return {
      fs,
      dataDir,
      filePath: path.join(dataDir, COMMANDCODE_INSTRUCTIONS_FILENAME),
    };
  } catch {
    return null;
  }
}

async function loadCommandCodeInstructionsSettings() {
  if (isWorkerRuntime()) return null;

  try {
    const localDbModule = await importLocalDbModule();
    const getSettings = localDbModule?.getSettings;
    if (typeof getSettings !== "function") return null;
    const settings = await getSettings();
    return settings?.commandcodeInstructions || null;
  } catch {
    return null;
  }
}

export function normalizeCommandCodeInstructionsSettings(raw) {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const enabled = raw.enabled !== false;
  const mode = raw.mode === "custom" ? "custom" : "default";
  return { enabled, mode };
}

export async function readCustomCommandCodeInstructionsFile() {
  try {
    const helpers = await loadNodeHelpers();
    if (!helpers || !helpers.fs.existsSync(helpers.filePath)) return null;
    const content = helpers.fs.readFileSync(helpers.filePath, "utf-8");
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  }
}

export async function writeCustomCommandCodeInstructionsFile(content) {
  const text = typeof content === "string" ? content : "";
  const helpers = await loadNodeHelpers();
  if (!helpers) return;
  if (!helpers.fs.existsSync(helpers.dataDir)) {
    helpers.fs.mkdirSync(helpers.dataDir, { recursive: true });
  }
  helpers.fs.writeFileSync(helpers.filePath, text, "utf-8");
}

export async function deleteCustomCommandCodeInstructionsFile() {
  try {
    const helpers = await loadNodeHelpers();
    if (helpers?.fs.existsSync(helpers.filePath)) {
      helpers.fs.unlinkSync(helpers.filePath);
    }
  } catch {
    // Best-effort.
  }
}

export function resolveCommandCodeInstructionsFromConfig(rawSettings, customContent) {
  const { enabled, mode } = normalizeCommandCodeInstructionsSettings(rawSettings);
  if (!enabled) return "";
  if (mode === "custom") {
    if (typeof customContent === "string" && customContent.length > 0) {
      return customContent;
    }
    return COMMANDCODE_DEFAULT_INSTRUCTIONS;
  }
  return COMMANDCODE_DEFAULT_INSTRUCTIONS;
}

export async function resolveCommandCodeInstructionsForRequest() {
  const raw = await loadCommandCodeInstructionsSettings();
  const { enabled, mode } = normalizeCommandCodeInstructionsSettings(raw);
  if (!enabled) return "";
  if (mode === "custom") {
    const custom = await readCustomCommandCodeInstructionsFile();
    if (typeof custom === "string" && custom.length > 0) return custom;
    return COMMANDCODE_DEFAULT_INSTRUCTIONS;
  }
  return COMMANDCODE_DEFAULT_INSTRUCTIONS;
}
