#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { exit } = require("node:process");

function parseArgs(args) {
  return {
    forwardArgs: [...args],
  };
}

function resolveNextCliPath() {
  return require.resolve("next/dist/bin/next");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = process.cwd();
  const standaloneServerPath = resolveStandaloneServerPath(projectRoot);

  if (hasStandaloneRuntime(standaloneServerPath) && isStandaloneBuildStale(projectRoot, standaloneServerPath)) {
    console.log("[Start] Standalone build is stale; rebuilding production bundle first.");
    await rebuildStandaloneBundle(projectRoot);
  }

  if (hasStandaloneRuntime(standaloneServerPath) && shouldSyncStandaloneAssets(standaloneServerPath)) {
    syncStandaloneAssets(projectRoot, standaloneServerPath);
  }

  const port = String(process.env.PORT || 20128);
  process.env.PORT = port;

  if (!(await isPortAvailable(port))) {
    console.error("");
    console.error(`[Start] Port ${port} is already in use.`);
    console.error(`[Start] Stop the process using it, then run npm start again.`);
    console.error(`[Start] Try one of these commands:`);
    console.error(`fuser -k ${port}/tcp`);
    console.error(`lsof -ti :${port} | xargs -r kill -9`);
    console.error("");
    exit(1);
  }

  const hasStandaloneServer = fs.existsSync(standaloneServerPath);
  const nextCliPath = hasStandaloneServer ? null : resolveNextCliPath();
  const child = hasStandaloneServer
    ? spawn(process.execPath, [standaloneServerPath, ...args.forwardArgs], {
        stdio: "inherit",
        env: process.env,
        shell: false,
      })
    : spawn(process.execPath, [nextCliPath, "start", "--port", port, ...args.forwardArgs], {
        stdio: "inherit",
        env: process.env,
        shell: false,
      });

  let forcedExitCode = null;

  if (!hasStandaloneServer) {
    console.log("[Start] Standalone server.js not found; falling back to next start.");
  }

  if (!child) {
    throw new Error("Failed to start production server process.");
  }

  child.stdout?.on?.("error", () => {});
  child.stderr?.on?.("error", () => {});

  child.on("error", (error) => {
    console.error("[Start] Failed to start production server process:", error);
    exit(1);
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!child.killed) {
        child.kill(signal);
      }
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    if (forcedExitCode !== null) {
      exit(forcedExitCode);
      return;
    }

    exit(code ?? 0);
  });
}

function resolveStandaloneServerPath(projectRoot = process.cwd()) {
  const dockerStyleStandaloneServerPath = path.join(projectRoot, "server.js");
  if (fs.existsSync(dockerStyleStandaloneServerPath)) {
    return dockerStyleStandaloneServerPath;
  }

  return path.join(projectRoot, ".next", "standalone", "server.js");
}

function hasStandaloneRuntime(standaloneServerPath) {
  return Boolean(standaloneServerPath) && fs.existsSync(standaloneServerPath);
}

function getLatestMtimeMs(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return 0;
  }

  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  if (entries.length === 0) {
    return stat.mtimeMs;
  }

  let latest = 0;
  for (const entry of entries) {
    latest = Math.max(latest, getLatestMtimeMs(path.join(targetPath, entry.name)));
  }
  return latest;
}

function getBuildInputPaths(projectRoot) {
  return [
    path.join(projectRoot, "src"),
    path.join(projectRoot, "scripts"),
    path.join(projectRoot, "public"),
    path.join(projectRoot, "package.json"),
    path.join(projectRoot, "package-lock.json"),
    path.join(projectRoot, "next.config.mjs"),
  ];
}

function getStandaloneOutputPaths(standaloneServerPath) {
  const standaloneRoot = path.dirname(standaloneServerPath);
  return [
    standaloneServerPath,
    path.join(standaloneRoot, ".next", "server"),
    path.join(standaloneRoot, ".next", "static"),
  ];
}

function isStandaloneBuildStale(projectRoot, standaloneServerPath) {
  if (!hasStandaloneRuntime(standaloneServerPath)) {
    return false;
  }

  const buildOutputTime = getStandaloneOutputPaths(standaloneServerPath).reduce(
    (latest, currentPath) => Math.max(latest, getLatestMtimeMs(currentPath)),
    0
  );
  const newestInputTime = getBuildInputPaths(projectRoot).reduce(
    (latest, currentPath) => Math.max(latest, getLatestMtimeMs(currentPath)),
    0
  );

  return newestInputTime > buildOutputTime;
}

function rebuildStandaloneBundle(projectRoot) {
  return new Promise((resolve, reject) => {
    const nextCliPath = resolveNextCliPath();
    const buildEnv = {
      ...process.env,
      NODE_ENV: "production",
    };

    const buildChild = spawn(process.execPath, [nextCliPath, "build", "--webpack"], {
      cwd: projectRoot,
      stdio: "inherit",
      env: buildEnv,
      shell: false,
    });

    buildChild.on("error", reject);
    buildChild.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Standalone rebuild exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Standalone rebuild exited with code ${code}`));
        return;
      }

      try {
        require(path.join(projectRoot, "scripts", "ensure-middleware-manifest.js"));
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function shouldSyncStandaloneAssets(standaloneServerPath) {
  if (!standaloneServerPath) {
    return false;
  }

  const normalizedPath = path.normalize(standaloneServerPath);
  const nestedStandaloneSegment = `${path.sep}.next${path.sep}standalone${path.sep}`;
  return normalizedPath.includes(nestedStandaloneSegment);
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.unref();
    server.on("error", () => resolve(false));
    server.listen({ port: Number(port), host: "0.0.0.0" }, () => {
      server.close(() => resolve(true));
    });
  });
}

function syncStandaloneAssets(projectRoot, standaloneServerPath) {
  const standaloneRoot = path.dirname(standaloneServerPath);
  const sourceStaticDir = path.join(projectRoot, ".next", "static");
  const sourcePublicDir = path.join(projectRoot, "public");
  const sourceMitmDir = path.join(projectRoot, "src", "mitm");
  const standaloneStaticDir = path.join(standaloneRoot, ".next", "static");
  const standalonePublicDir = path.join(standaloneRoot, "public");
  const standaloneMitmDir = path.join(standaloneRoot, "src", "mitm");

  if (fs.existsSync(sourceStaticDir)) {
    fs.mkdirSync(path.dirname(standaloneStaticDir), { recursive: true });
    fs.rmSync(standaloneStaticDir, { recursive: true, force: true });
    fs.cpSync(sourceStaticDir, standaloneStaticDir, { recursive: true, force: true });
  }

  if (fs.existsSync(sourcePublicDir)) {
    fs.rmSync(standalonePublicDir, { recursive: true, force: true });
    fs.cpSync(sourcePublicDir, standalonePublicDir, { recursive: true, force: true });
  }

  if (fs.existsSync(sourceMitmDir)) {
    fs.mkdirSync(path.dirname(standaloneMitmDir), { recursive: true });
    fs.rmSync(standaloneMitmDir, { recursive: true, force: true });
    fs.cpSync(sourceMitmDir, standaloneMitmDir, { recursive: true, force: true });
  }

  console.log("[Start] Synced standalone public/static assets.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[start] Failed to bootstrap server:", error);
    exit(1);
  });
}

module.exports = {
  getBuildInputPaths,
  getLatestMtimeMs,
  getStandaloneOutputPaths,
  hasStandaloneRuntime,
  isPortAvailable,
  isStandaloneBuildStale,
  main,
  parseArgs,
  rebuildStandaloneBundle,
  resolveNextCliPath,
  resolveStandaloneServerPath,
  shouldSyncStandaloneAssets,
  syncStandaloneAssets,
};
