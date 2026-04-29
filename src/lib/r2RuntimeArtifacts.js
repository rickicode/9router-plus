import {
  exportDb,
} from "@/lib/localDb";

function cloneRecord(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function sanitizeRuntimeConnection(connection) {
  return cloneRecord(connection);
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

function buildRuntimeSettings(settings = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const safeSettings = cloneRecord(source);

  delete safeSettings.r2Config;
  delete safeSettings.cloudUrls;
  delete safeSettings.r2RuntimePublicBaseUrl;
  delete safeSettings.r2RuntimeCacheTtlSeconds;
  delete safeSettings.r2LastRuntimePublishAt;
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

export async function buildBackupArtifact(state = null) {
  if (isArtifactState(state)) {
    return cloneRecord(state);
  }

  return await exportDb();
}

export async function buildRuntimeArtifact(stateOrOptions = null, maybeOptions = {}) {
  const hasProvidedState = isArtifactState(stateOrOptions);
  const resolved = hasProvidedState
    ? normalizeArtifactState(stateOrOptions)
    : normalizeArtifactState(await exportDb());
  const options = hasProvidedState ? maybeOptions : stateOrOptions || {};
  const providers = {};

  for (const connection of resolved.providerConnections) {
    if (!connection?.id) continue;
    if (connection.isActive === false) continue;
    if (connection.routingStatus !== "eligible") continue;
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

export async function buildR2ArtifactsFromState() {
  const state = await exportDb();
  const generatedAt = new Date().toISOString();
  const [backup, runtime] = await Promise.all([
    buildBackupArtifact(state),
    buildRuntimeArtifact(state, { generatedAt }),
  ]);

  return { backup, runtime };
}
