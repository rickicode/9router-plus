import { loadSingletonFromSqlite, upsertSingleton } from "./sqliteHelpers.js";

const CONFIG_FILE = null;

const DEFAULT_CONFIG = {
  version: 1,
};

function cloneDefaultConfig() {
  return {
    version: DEFAULT_CONFIG.version,
  };
}

function ensureConfigShape(config) {
  const next = config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
  if (typeof next.version !== "number") next.version = DEFAULT_CONFIG.version;
  return next;
}

export async function readRuntimeConfig() {
  return ensureConfigShape(loadSingletonFromSqlite("runtimeConfig") || cloneDefaultConfig());
}

export async function writeRuntimeConfig(config) {
  const next = ensureConfigShape(config);
  upsertSingleton("runtimeConfig", next);
  return next;
}

export function cloneRuntimeConfig(config) {
  return ensureConfigShape(JSON.parse(JSON.stringify(config || cloneDefaultConfig())));
}

export { CONFIG_FILE };
