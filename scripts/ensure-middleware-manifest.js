#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', '.next', 'standalone', '.next', 'server', 'middleware-manifest.json');
const manifestDir = path.dirname(manifestPath);

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
