import {
  exportDb,
  getProviderConnections,
} from "@/lib/localDb";

export const R2_FULL_CREDENTIALS_OBJECT_KEY = "runtime/credentials.full.json";
export const R2_RUNTIME_CONFIG_OBJECT_KEY = "runtime/runtime.config.json";

function cloneRecord(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function sanitizeRuntimeConnection(connection) {
  return cloneRecord(connection);
}

function shouldIncludeRuntimeConnection(connection) {
  return Boolean(
    connection?.id &&
    connection.isActive !== false &&
    connection.routingStatus === "eligible"
  );
}

function normalizeRuntimeApiKeys(apiKeys) {
  if (!Array.isArray(apiKeys)) return [];
  return apiKeys
    .filter((apiKey) => apiKey?.isActive !== false)
    .map((apiKey) => cloneRecord(apiKey));
}

function normalizeRuntimeMorphSettings(morph = {}) {
  if (!morph || typeof morph !== "object" || Array.isArray(morph)) {
    return null;
  }

  const baseUrl = typeof morph.baseUrl === "string" ? morph.baseUrl.trim() : "";
  const apiKeys = Array.isArray(morph.apiKeys)
    ? morph.apiKeys
        .filter((entry) => entry?.key && entry.isExhausted !== true && entry.status !== "inactive")
        .map((entry) => ({
          id: entry?.id,
          ...cloneRecord(entry),
        }))
    : [];

  if (!baseUrl || apiKeys.length === 0) {
    return null;
  }

  return {
    baseUrl,
    apiKeys,
    roundRobinEnabled: morph.roundRobinEnabled === true,
  };
}

function buildRoutingStrategySettings(settings = {}) {
  const safeSettings = buildRuntimeSettings(settings);
  delete safeSettings.morph;
  return safeSettings;
}

function buildRuntimeSettings(settings = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const safeSettings = cloneRecord(source);

  delete safeSettings.r2Config;
  delete safeSettings.cloudUrls;
  delete safeSettings.r2RuntimePublicBaseUrl;
  delete safeSettings.r2RuntimeCacheTtlSeconds;
  delete safeSettings.r2LastRuntimePublishAt;
  delete safeSettings.r2LastRuntimeArtifactHash;
  delete safeSettings.r2LastBackupAt;
  delete safeSettings.r2LastRestoreAt;
  delete safeSettings.r2LastSqliteBackupFingerprint;
  delete safeSettings.r2BackupEncryptionKey;
  delete safeSettings.r2AutoPublishEnabled;
  delete safeSettings.r2BackupEnabled;
  delete safeSettings.r2SqliteBackupSchedule;

  const morph = normalizeRuntimeMorphSettings(source.morph);
  if (morph) {
    safeSettings.morph = morph;
  } else {
    delete safeSettings.morph;
  }

  return safeSettings;
}

function resolveGeneratedAt(options = {}) {
  return typeof options.generatedAt === "string" && options.generatedAt ? options.generatedAt : new Date().toISOString();
}

function isArtifactState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return [
    "format",
    "schemaVersion",
    "providerConnections",
    "providerNodes",
    "proxyPools",
    "modelAliases",
    "customModels",
    "mitmAlias",
    "combos",
    "apiKeys",
    "settings",
    "pricing",
  ].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function normalizeArtifactState(snapshot) {
  const next = snapshot && typeof snapshot === "object" ? cloneRecord(snapshot) : {};

  return {
    ...next,
    providerConnections: Array.isArray(next.providerConnections) ? next.providerConnections : [],
    modelAliases: next.modelAliases && typeof next.modelAliases === "object" ? next.modelAliases : {},
    combos: Array.isArray(next.combos) ? next.combos : [],
    apiKeys: Array.isArray(next.apiKeys) ? next.apiKeys : [],
    settings: next.settings && typeof next.settings === "object" ? next.settings : {},
  };
}

async function getRuntimeArtifactState(snapshot = null) {
  if (isArtifactState(snapshot)) {
    return normalizeArtifactState(snapshot);
  }

  const [exportedSnapshot, mergedConnections] = await Promise.all([
    exportDb(),
    getProviderConnections(),
  ]);
  const resolved = normalizeArtifactState(exportedSnapshot);
  resolved.providerConnections = Array.isArray(mergedConnections)
    ? mergedConnections.map((connection) => cloneRecord(connection))
    : [];
  return resolved;
}

export async function buildBackupArtifact(state = null) {
  if (isArtifactState(state)) {
    return cloneRecord(state);
  }

  return await exportDb();
}

export async function buildRuntimeArtifact(stateOrOptions = null, maybeOptions = {}) {
  const hasProvidedState = isArtifactState(stateOrOptions);
  const resolved = hasProvidedState
    ? await getRuntimeArtifactState(stateOrOptions)
    : await getRuntimeArtifactState();
  const options = hasProvidedState ? maybeOptions : stateOrOptions || {};
  const providers = {};

  for (const connection of resolved.providerConnections) {
    if (!shouldIncludeRuntimeConnection(connection)) continue;
    providers[connection.id] = sanitizeRuntimeConnection(connection);
  }

  return {
    generatedAt: resolveGeneratedAt(options),
    providers,
    modelAliases: cloneRecord(resolved.modelAliases),
    combos: cloneRecord(resolved.combos),
    apiKeys: normalizeRuntimeApiKeys(resolved.apiKeys),
    settings: buildRuntimeSettings(resolved.settings),
  };
}

export async function buildEligibleRuntimeArtifact(stateOrOptions = null, maybeOptions = {}) {
  const runtime = await buildRuntimeArtifact(stateOrOptions, maybeOptions);

  return {
    generatedAt: runtime.generatedAt,
    providers: runtime.providers,
  };
}

export async function buildFullCredentialsArtifact(stateOrOptions = null, maybeOptions = {}) {
  const hasProvidedState = isArtifactState(stateOrOptions);
  const resolved = hasProvidedState
    ? await getRuntimeArtifactState(stateOrOptions)
    : await getRuntimeArtifactState();
  const options = hasProvidedState ? maybeOptions : stateOrOptions || {};
  const providers = {};

  for (const connection of resolved.providerConnections) {
    if (!shouldIncludeRuntimeConnection(connection)) continue;
    providers[connection.id] = sanitizeRuntimeConnection(connection);
  }

  const morph = normalizeRuntimeMorphSettings(resolved.settings?.morph);

  return {
    schemaVersion: 1,
    generatedAt: resolveGeneratedAt(options),
    providers,
    apiKeys: normalizeRuntimeApiKeys(resolved.apiKeys),
    morph: morph || null,
  };
}

export async function buildRuntimeConfigArtifact(stateOrOptions = null, maybeOptions = {}) {
  const hasProvidedState = isArtifactState(stateOrOptions);
  const resolved = hasProvidedState
    ? normalizeArtifactState(stateOrOptions)
    : normalizeArtifactState(await exportDb());
  const options = hasProvidedState ? maybeOptions : stateOrOptions || {};
  const settings = buildRoutingStrategySettings(resolved.settings);

  return {
    schemaVersion: 1,
    generatedAt: resolveGeneratedAt(options),
    strategy: settings?.strategy || "priority",
    modelAliases: cloneRecord(resolved.modelAliases),
    combos: cloneRecord(resolved.combos),
    apiKeys: normalizeRuntimeApiKeys(resolved.apiKeys),
    settings,
  };
}

export async function buildR2ArtifactsFromState() {
  const state = await exportDb();
  const generatedAt = new Date().toISOString();
  const mergedConnections = await getProviderConnections();
  const runtimeState = Array.isArray(mergedConnections) && mergedConnections.length > 0
    ? {
        ...state,
        providerConnections: mergedConnections.map((connection) => cloneRecord(connection)),
      }
    : state;
  const [backup, runtime, eligible, credentials, runtimeConfig] = await Promise.all([
    buildBackupArtifact(state),
    buildRuntimeArtifact(runtimeState, { generatedAt }),
    buildEligibleRuntimeArtifact(runtimeState, { generatedAt }),
    buildFullCredentialsArtifact(runtimeState, { generatedAt }),
    buildRuntimeConfigArtifact(runtimeState, { generatedAt }),
  ]);

  return { backup, runtime, eligible, credentials, runtimeConfig };
}
