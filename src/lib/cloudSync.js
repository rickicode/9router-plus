import { getConsistentMachineId } from "@/shared/utils/machineId";
import { getProviderConnections, getModelAliases, getCombos, getSettings, getApiKeys } from "./localDb.js";
import { getCloudUrl } from "./cloudUrlResolver.js";

async function getFirstApiKey() {
  const apiKeys = await getApiKeys();
  if (!Array.isArray(apiKeys)) return "";
  const firstActiveKey = apiKeys.find((apiKey) => apiKey?.isActive !== false && typeof apiKey?.key === "string" && apiKey.key);
  return firstActiveKey?.key || "";
}

/**
 * Format connection for cloud sync
 */
function formatConnection(conn) {
  return {
    id: conn.id,
    provider: conn.provider,
    accessToken: conn.accessToken,
    refreshToken: conn.refreshToken,
    expiresAt: conn.expiresAt,
    isActive: conn.isActive !== false,
  };
}

/**
 * Sync config to cloud worker
 */
export async function syncToCloud() {
  const machineId = await getConsistentMachineId();
  let cloudUrl = "";
  try {
    cloudUrl = await getCloudUrl();
  } catch (error) {
    throw new Error(error?.message || "Cloud URL unavailable");
  }

  const connections = await getProviderConnections();
  const modelAliases = await getModelAliases();
  const combos = await getCombos();
  const apiKeys = await getApiKeys();
  const settings = await getSettings();

  const payload = {
    providers: connections.map(formatConnection),
    modelAliases,
    combos,
    // NOTE: API keys/tokens are sent to the worker in plaintext application payloads; fixing this requires an encryption/key-management system.
    apiKeys,
    settings: {
      roundRobin: settings.roundRobin || false,
      sticky: settings.sticky || false,
      stickyDuration: settings.stickyDuration || 300,
      comboStrategy: settings.comboStrategy || "fallback",
      comboStrategies: settings.comboStrategies || {},
      providerStrategies: settings.providerStrategies || {},
    },
  };

  const response = await fetch(`${cloudUrl}/sync/${machineId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await getFirstApiKey()}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Sync failed: ${response.statusText}`);
  }

  return await response.json();
}
