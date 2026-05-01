#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', '.next', 'standalone', '.next', 'server', 'middleware-manifest.json');
const manifestDir = path.dirname(manifestPath);
const projectRoot = path.join(__dirname, '..');

// Create directory if it doesn't exist
if (!fs.existsSync(manifestDir)) {
  fs.mkdirSync(manifestDir, { recursive: true });
}

// Create empty middleware manifest if it doesn't exist
if (!fs.existsSync(manifestPath)) {
  const emptyManifest = {
    sortedMiddleware: [],
    middleware: {},
    functions: {},
    version: 2
  };
  
  fs.writeFileSync(manifestPath, JSON.stringify(emptyManifest, null, 2));
  console.log('[Build] Created empty middleware-manifest.json');
} else {
  console.log('[Build] middleware-manifest.json already exists');
}

for (const relativePath of [
  'src/lib/usageWorker/aliasLoader.mjs',
  'src/lib/usageWorker/workerBootstrap.cjs',
  'src/lib/usageWorker/worker.js',
]) {
  const sourcePath = path.join(projectRoot, relativePath);
  const targetPath = path.join(projectRoot, '.next', 'standalone', relativePath);
  if (!fs.existsSync(sourcePath)) continue;

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

console.log('[Build] Synced usage worker standalone files');
