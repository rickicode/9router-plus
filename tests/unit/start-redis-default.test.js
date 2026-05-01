import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getBuildInputPaths,
  getStandaloneOutputPaths,
  isStandaloneBuildStale,
  parseArgs,
  resolveNextCliPath,
} from "../../scripts/start.js";

function setInputTimes(projectRoot, atTime) {
  const inputPaths = [
    path.join(projectRoot, "src", "route.js"),
    path.join(projectRoot, "scripts", "placeholder.js"),
    path.join(projectRoot, "package.json"),
    path.join(projectRoot, "package-lock.json"),
    path.join(projectRoot, "next.config.mjs"),
  ];

  for (const inputPath of inputPaths) {
    fs.utimesSync(inputPath, atTime, atTime);
  }
}

function setOutputTimes(projectRoot, atTime) {
  const outputPaths = [
    path.join(projectRoot, ".next", "standalone", "server.js"),
    path.join(projectRoot, ".next", "standalone", ".next", "server", "route.js"),
  ];

  for (const outputPath of outputPaths) {
    fs.utimesSync(outputPath, atTime, atTime);
  }
}

describe("start script helpers", () => {
  it("preserves forwarded CLI args for the server process", () => {
    expect(parseArgs(["--hostname", "0.0.0.0", "--keepAliveTimeout", "60000"]))
      .toEqual({ forwardArgs: ["--hostname", "0.0.0.0", "--keepAliveTimeout", "60000"] });
  });

  it("resolves the local Next CLI for direct node/bun start execution", () => {
    expect(resolveNextCliPath()).toMatch(/next[/\\]dist[/\\]bin[/\\]next$/);
  });
});

describe("standalone build freshness", () => {
  it("tracks the expected build input paths", () => {
    const projectRoot = "/tmp/project-root";
    expect(getBuildInputPaths(projectRoot)).toEqual([
      path.join(projectRoot, "src"),
      path.join(projectRoot, "scripts"),
      path.join(projectRoot, "public"),
      path.join(projectRoot, "package.json"),
      path.join(projectRoot, "package-lock.json"),
      path.join(projectRoot, "next.config.mjs"),
    ]);
  });

  it("tracks the concrete standalone runtime outputs", () => {
    const standaloneServerPath = "/tmp/project/.next/standalone/server.js";
    expect(getStandaloneOutputPaths(standaloneServerPath)).toEqual([
      standaloneServerPath,
      path.join("/tmp/project/.next/standalone", ".next", "server"),
      path.join("/tmp/project/.next/standalone", ".next", "static"),
    ]);
  });

  it("marks the standalone runtime stale when source files are newer than the build output", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "9router-start-stale-"));

    try {
      fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, "scripts"), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, ".next", "standalone", ".next", "server"), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, "package.json"), "{}");
      fs.writeFileSync(path.join(projectRoot, "package-lock.json"), "{}");
      fs.writeFileSync(path.join(projectRoot, "next.config.mjs"), "export default {}\n");

      const sourcePath = path.join(projectRoot, "src", "route.js");
      const standaloneServerPath = path.join(projectRoot, ".next", "standalone", "server.js");
      const compiledRoutePath = path.join(projectRoot, ".next", "standalone", ".next", "server", "route.js");
      const placeholderScriptPath = path.join(projectRoot, "scripts", "placeholder.js");
      fs.writeFileSync(sourcePath, "export const value = 1;\n");
      fs.writeFileSync(placeholderScriptPath, "module.exports = {};\n");
      fs.writeFileSync(standaloneServerPath, "console.log('server');\n");
      fs.writeFileSync(compiledRoutePath, "exports.value = 1;\n");

      const older = new Date("2026-04-30T12:00:00.000Z");
      const newer = new Date("2026-04-30T12:05:00.000Z");
      setInputTimes(projectRoot, older);
      setOutputTimes(projectRoot, older);
      fs.utimesSync(sourcePath, newer, newer);

      expect(isStandaloneBuildStale(projectRoot, standaloneServerPath)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("keeps the standalone runtime fresh when build output is newer than inputs", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "9router-start-fresh-"));

    try {
      fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, "scripts"), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, ".next", "standalone", ".next", "server"), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, "package.json"), "{}");
      fs.writeFileSync(path.join(projectRoot, "package-lock.json"), "{}");
      fs.writeFileSync(path.join(projectRoot, "next.config.mjs"), "export default {}\n");

      const sourcePath = path.join(projectRoot, "src", "route.js");
      const standaloneServerPath = path.join(projectRoot, ".next", "standalone", "server.js");
      const compiledRoutePath = path.join(projectRoot, ".next", "standalone", ".next", "server", "route.js");
      const placeholderScriptPath = path.join(projectRoot, "scripts", "placeholder.js");
      fs.writeFileSync(sourcePath, "export const value = 1;\n");
      fs.writeFileSync(placeholderScriptPath, "module.exports = {};\n");
      fs.writeFileSync(standaloneServerPath, "console.log('server');\n");
      fs.writeFileSync(compiledRoutePath, "exports.value = 1;\n");

      const older = new Date("2026-04-30T12:00:00.000Z");
      const newer = new Date("2026-04-30T12:05:00.000Z");
      setInputTimes(projectRoot, older);
      setOutputTimes(projectRoot, newer);

      expect(isStandaloneBuildStale(projectRoot, standaloneServerPath)).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
