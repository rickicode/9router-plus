const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { register } = require("node:module");

process.env.WORKER_PROJECT_ROOT ||= path.resolve(__dirname, "..", "..", "..", "..");

register(
  path.join(process.env.WORKER_PROJECT_ROOT, "src", "lib", "usageWorker", "aliasLoader.mjs"),
  pathToFileURL(`${process.cwd()}/`),
);

import("./worker.js").catch((error) => {
  console.error("[UsageWorker] Bootstrap failed:", error);
  process.exit(1);
});
