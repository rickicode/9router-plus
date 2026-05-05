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

import { CODEX_DEFAULT_INSTRUCTIONS } from "./codexInstructions.js";

export const CODEX_INSTRUCTIONS_FILENAME = "codex-instructions.md";
export const CODEX_INSTRUCTIONS_FILE_PATH = null;

const DEFAULT_SETTINGS = Object.freeze({ enabled: true, mode: "default" });

function isWorkerRuntime() {
	return (
		typeof WebSocketPair !== "undefined" || typeof EdgeRuntime !== "undefined"
	);
}

async function loadNodeHelpers() {
	try {
		const [{ default: fs }, { default: path }, { DATA_DIR }] =
			await Promise.all([
				import("fs"),
				import("path"),
				import("@/lib/dataDir.js"),
			]);

		return {
			fs,
			dataDir: DATA_DIR,
			filePath: path.join(DATA_DIR, CODEX_INSTRUCTIONS_FILENAME),
		};
	} catch {
		return null;
	}
}

async function loadCodexInstructionsSettings() {
	if (isWorkerRuntime()) {
		return null;
	}

	try {
		const { getSettings } = await import("@/lib/localDb.js");
		const settings = await getSettings();
		return settings?.codexInstructions || null;
	} catch {
		return null;
	}
}

// Normalize a settings.codexInstructions object into a known shape.
export function normalizeCodexInstructionsSettings(raw) {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
	const enabled = raw.enabled !== false; // default true
	const mode = raw.mode === "custom" ? "custom" : "default";
	return { enabled, mode };
}

// Read the user's custom instructions .md file, or null if absent / unreadable.
export async function readCustomCodexInstructionsFile() {
	try {
		const helpers = await loadNodeHelpers();
		if (!helpers || !helpers.fs.existsSync(helpers.filePath)) return null;
		const content = helpers.fs.readFileSync(helpers.filePath, "utf-8");
		return typeof content === "string" ? content : null;
	} catch {
		return null;
	}
}

// Write the user's custom instructions .md file. Creates parent dir as needed.
export async function writeCustomCodexInstructionsFile(content) {
	const text = typeof content === "string" ? content : "";
	const helpers = await loadNodeHelpers();
	if (!helpers) return;
	if (!helpers.fs.existsSync(helpers.dataDir)) {
		helpers.fs.mkdirSync(helpers.dataDir, { recursive: true });
	}
	helpers.fs.writeFileSync(helpers.filePath, text, "utf-8");
}

// Delete the user's custom instructions .md file. No-op if absent.
export async function deleteCustomCodexInstructionsFile() {
	try {
		const helpers = await loadNodeHelpers();
		if (helpers?.fs.existsSync(helpers.filePath)) {
			helpers.fs.unlinkSync(helpers.filePath);
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
	const raw = await loadCodexInstructionsSettings();
	const { enabled, mode } = normalizeCodexInstructionsSettings(raw);
	if (!enabled) return "";
	if (mode === "custom") {
		const custom = await readCustomCodexInstructionsFile();
		if (typeof custom === "string" && custom.length > 0) return custom;
		return CODEX_DEFAULT_INSTRUCTIONS;
	}
	return CODEX_DEFAULT_INSTRUCTIONS;
}
