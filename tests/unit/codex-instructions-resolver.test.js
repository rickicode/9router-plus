/**
 * Tests for the user-controlled Codex default instructions resolver.
 * Covers the three states (enabled/default, enabled/custom, disabled) plus
 * input normalization and file fallback behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { CODEX_DEFAULT_INSTRUCTIONS } from "../../open-sse/config/codexInstructions.js";

let resolverModule;
let DATA_DIR;

beforeEach(async () => {
  vi.resetModules();
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "codex-instr-"));
  process.env.DATA_DIR = DATA_DIR;
  resolverModule = await import("../../open-sse/config/codexInstructionsResolver.js");
});

afterEach(() => {
  delete process.env.DATA_DIR;
  if (DATA_DIR && fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
});

describe("normalizeCodexInstructionsSettings", () => {
  it("returns enabled+default for null/undefined/non-object input", () => {
    const { normalizeCodexInstructionsSettings } = resolverModule;
    expect(normalizeCodexInstructionsSettings(null)).toEqual({ enabled: true, mode: "default" });
    expect(normalizeCodexInstructionsSettings(undefined)).toEqual({ enabled: true, mode: "default" });
    expect(normalizeCodexInstructionsSettings("foo")).toEqual({ enabled: true, mode: "default" });
  });

  it("preserves enabled=false explicitly", () => {
    const { normalizeCodexInstructionsSettings } = resolverModule;
    expect(normalizeCodexInstructionsSettings({ enabled: false })).toEqual({ enabled: false, mode: "default" });
  });

  it("clamps unknown mode values to 'default'", () => {
    const { normalizeCodexInstructionsSettings } = resolverModule;
    expect(normalizeCodexInstructionsSettings({ mode: "weird" })).toEqual({ enabled: true, mode: "default" });
  });

  it("preserves mode='custom'", () => {
    const { normalizeCodexInstructionsSettings } = resolverModule;
    expect(normalizeCodexInstructionsSettings({ mode: "custom" })).toEqual({ enabled: true, mode: "custom" });
  });
});

describe("resolveCodexInstructionsFromConfig (sync, no file IO)", () => {
  it("returns built-in default in enabled+default mode", () => {
    const { resolveCodexInstructionsFromConfig } = resolverModule;
    expect(resolveCodexInstructionsFromConfig({ enabled: true, mode: "default" }, null))
      .toBe(CODEX_DEFAULT_INSTRUCTIONS);
  });

  it("returns custom content in enabled+custom mode when content is non-empty", () => {
    const { resolveCodexInstructionsFromConfig } = resolverModule;
    const result = resolveCodexInstructionsFromConfig({ enabled: true, mode: "custom" }, "My custom prompt");
    expect(result).toBe("My custom prompt");
  });

  it("falls back to built-in default in custom mode when no content provided", () => {
    const { resolveCodexInstructionsFromConfig } = resolverModule;
    expect(resolveCodexInstructionsFromConfig({ enabled: true, mode: "custom" }, null))
      .toBe(CODEX_DEFAULT_INSTRUCTIONS);
    expect(resolveCodexInstructionsFromConfig({ enabled: true, mode: "custom" }, ""))
      .toBe(CODEX_DEFAULT_INSTRUCTIONS);
  });

  it("returns empty string when disabled (regardless of mode)", () => {
    const { resolveCodexInstructionsFromConfig } = resolverModule;
    expect(resolveCodexInstructionsFromConfig({ enabled: false, mode: "default" }, null)).toBe("");
    expect(resolveCodexInstructionsFromConfig({ enabled: false, mode: "custom" }, "ignored")).toBe("");
  });
});

describe("custom instructions file IO", () => {
  it("read returns null when no file exists", async () => {
    const { readCustomCodexInstructionsFile } = resolverModule;
    await expect(readCustomCodexInstructionsFile()).resolves.toBe(null);
  });

  it("write -> read round-trips content; delete clears it", async () => {
    const { writeCustomCodexInstructionsFile, readCustomCodexInstructionsFile, deleteCustomCodexInstructionsFile } =
      resolverModule;

    await writeCustomCodexInstructionsFile("Hello custom Codex prompt");
    await expect(readCustomCodexInstructionsFile()).resolves.toBe("Hello custom Codex prompt");

    await deleteCustomCodexInstructionsFile();
    await expect(readCustomCodexInstructionsFile()).resolves.toBe(null);
  });

  it("delete is a no-op when file does not exist", async () => {
    const { deleteCustomCodexInstructionsFile } = resolverModule;
    await expect(deleteCustomCodexInstructionsFile()).resolves.toBeUndefined();
  });
});
