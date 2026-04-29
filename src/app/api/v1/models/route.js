import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import { getProviderAlias, isAnthropicCompatibleProvider, isOpenAICompatibleProvider } from "@/shared/constants/providers";
import { getProviderConnections, getCombos } from "@/lib/localDb";

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

// Matches provider IDs that are upstream/cross-instance connections (contain a UUID suffix)
const UPSTREAM_CONNECTION_RE = /[-_][0-9a-f]{8,}$/i;
const COMPATIBLE_MODELS_CACHE_TTL_MS = 15_000;
const COMPATIBLE_MODELS_FETCH_TIMEOUT_MS = 2_500;
const FINAL_MODELS_RESPONSE_CACHE_TTL_MS = 10_000;
const compatibleModelsCache = new Map();
const compatibleModelsInFlight = new Map();
let finalModelsResponseCache = null;

function getCompatibleModelsCacheKey(connection) {
  return JSON.stringify({
    provider: connection?.provider || "",
    baseUrl: typeof connection?.providerSpecificData?.baseUrl === "string"
      ? connection.providerSpecificData.baseUrl.trim().replace(/\/$/, "")
      : "",
    apiKeySuffix: typeof connection?.apiKey === "string" ? connection.apiKey.slice(-8) : "",
  });
}

function getFinalModelsResponseCacheKey(connections, combos) {
  return JSON.stringify({
    connections: (connections || []).map((connection) => ({
      provider: connection?.provider || "",
      isActive: connection?.isActive !== false,
      prefix: connection?.providerSpecificData?.prefix || "",
      baseUrl: connection?.providerSpecificData?.baseUrl || "",
      enabledModels: Array.isArray(connection?.providerSpecificData?.enabledModels)
        ? [...connection.providerSpecificData.enabledModels]
        : [],
      apiKeySuffix: typeof connection?.apiKey === "string" ? connection.apiKey.slice(-8) : "",
    })),
    combos: (combos || []).map((combo) => ({
      name: combo?.name || "",
    })),
  });
}

function readCompatibleModelsCache(connection) {
  const cacheKey = getCompatibleModelsCacheKey(connection);
  const cached = compatibleModelsCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.updatedAt >= COMPATIBLE_MODELS_CACHE_TTL_MS) {
    compatibleModelsCache.delete(cacheKey);
    return null;
  }
  return cached.modelIds;
}

function writeCompatibleModelsCache(connection, modelIds) {
  compatibleModelsCache.set(getCompatibleModelsCacheKey(connection), {
    modelIds,
    updatedAt: Date.now(),
  });
}

function readFinalModelsResponseCache(cacheKey) {
  if (!finalModelsResponseCache || finalModelsResponseCache.cacheKey !== cacheKey) {
    return null;
  }
  if (Date.now() - finalModelsResponseCache.updatedAt >= FINAL_MODELS_RESPONSE_CACHE_TTL_MS) {
    finalModelsResponseCache = null;
    return null;
  }
  return finalModelsResponseCache.payload;
}

function writeFinalModelsResponseCache(cacheKey, payload) {
  finalModelsResponseCache = {
    cacheKey,
    payload,
    updatedAt: Date.now(),
  };
}

async function fetchCompatibleModelIds(connection) {
  if (!connection?.apiKey) return [];

  const cached = readCompatibleModelsCache(connection);
  if (cached) return cached;

  const cacheKey = getCompatibleModelsCacheKey(connection);
  const inFlight = compatibleModelsInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const fetchPromise = (async () => {
    const baseUrl = typeof connection?.providerSpecificData?.baseUrl === "string"
      ? connection.providerSpecificData.baseUrl.trim().replace(/\/$/, "")
      : "";

    if (!baseUrl) return [];

    let url = `${baseUrl}/models`;
    const headers = {
      "Content-Type": "application/json",
    };

    if (isOpenAICompatibleProvider(connection.provider)) {
      headers.Authorization = `Bearer ${connection.apiKey}`;
    } else if (isAnthropicCompatibleProvider(connection.provider)) {
      if (url.endsWith("/messages/models")) {
        url = `${url.slice(0, -16)}/models`;
      } else if (url.endsWith("/messages")) {
        url = `${url.slice(0, -9)}/models`;
      }
      headers["x-api-key"] = connection.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      return [];
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), COMPATIBLE_MODELS_FETCH_TIMEOUT_MS);
      const response = await fetch(url, {
        method: "GET",
        headers,
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) return [];

      const data = await response.json();
      const rawModels = parseOpenAIStyleModels(data);
      const modelIds = Array.from(
        new Set(
          rawModels
            .map((model) => model?.id || model?.name || model?.model)
            .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "")
        )
      );

      writeCompatibleModelsCache(connection, modelIds);
      return modelIds;
    } catch {
      return [];
    }
  })();

  compatibleModelsInFlight.set(cacheKey, fetchPromise);

  try {
    return await fetchPromise;
  } finally {
    compatibleModelsInFlight.delete(cacheKey);
  }
}

function normalizeModelIds(rawModelIds, outputAlias, staticAlias, providerId) {
  return rawModelIds
    .map((modelId) => {
      if (modelId.startsWith(`${outputAlias}/`)) {
        return modelId.slice(outputAlias.length + 1);
      }
      if (modelId.startsWith(`${staticAlias}/`)) {
        return modelId.slice(staticAlias.length + 1);
      }
      if (modelId.startsWith(`${providerId}/`)) {
        return modelId.slice(providerId.length + 1);
      }
      return modelId;
    })
    .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");
}

async function resolveProviderModelIds(providerEntries) {
  const remoteResults = await Promise.allSettled(
    providerEntries.map(async (entry) => {
      const { providerId, conn, providerModels } = entry;
      const enabledModels = conn?.providerSpecificData?.enabledModels;
      const hasExplicitEnabledModels =
        Array.isArray(enabledModels) && enabledModels.length > 0;
      const isCompatibleProvider =
        isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

      let rawModelIds = hasExplicitEnabledModels
        ? Array.from(
            new Set(
              enabledModels.filter(
                (modelId) => typeof modelId === "string" && modelId.trim() !== "",
              ),
            ),
          )
        : providerModels.map((model) => model.id);

      if (isCompatibleProvider && rawModelIds.length === 0 && !UPSTREAM_CONNECTION_RE.test(providerId)) {
        rawModelIds = await fetchCompatibleModelIds(conn);
      }

      return {
        ...entry,
        modelIds: normalizeModelIds(rawModelIds, entry.outputAlias, entry.staticAlias, providerId),
      };
    })
  );

  return remoteResults.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - compatible models list
 * Returns models from all active providers and combos in OpenAI format
 */
export async function GET() {
  try {
    const [connectionsResult, combosResult] = await Promise.allSettled([
      getProviderConnections(),
      getCombos(),
    ]);

    let connections = [];
    if (connectionsResult.status === "fulfilled") {
      connections = Array.isArray(connectionsResult.value)
        ? connectionsResult.value.filter((connection) => connection.isActive !== false)
        : [];
    } else {
      console.log("Could not fetch providers, returning all models");
    }

    let combos = [];
    if (combosResult.status === "fulfilled") {
      combos = Array.isArray(combosResult.value) ? combosResult.value : [];
    } else {
      console.log("Could not fetch combos");
    }

    const finalCacheKey = getFinalModelsResponseCacheKey(connections, combos);
    const cachedPayload = readFinalModelsResponseCache(finalCacheKey);
    if (cachedPayload) {
      return Response.json(cachedPayload, {
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Build first active connection per provider (connections already sorted by priority)
    const activeConnectionByProvider = new Map();
    for (const conn of connections) {
      if (!activeConnectionByProvider.has(conn.provider)) {
        activeConnectionByProvider.set(conn.provider, conn);
      }
    }

    // Collect models from active providers (or all if none active)
    const models = [];
    const timestamp = Math.floor(Date.now() / 1000);

    // Add combos first (they appear at the top)
    for (const combo of combos) {
      models.push({
        id: combo.name,
        object: "model",
        created: timestamp,
        owned_by: "combo",
        permission: [],
        root: combo.name,
        parent: null,
      });
    }

    // Add provider models
    if (connections.length === 0) {
      // DB unavailable or no active providers -> return all static models
      for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS)) {
        for (const model of providerModels) {
          models.push({
            id: `${alias}/${model.id}`,
            object: "model",
            created: timestamp,
            owned_by: alias,
            permission: [],
            root: model.id,
            parent: null,
          });
        }
      }
    } else {
      const providerEntries = Array.from(activeConnectionByProvider.entries()).map(([providerId, conn]) => {
        const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
        const outputAlias = (
          conn?.providerSpecificData?.prefix
          || getProviderAlias(providerId)
          || staticAlias
        ).trim();
        const providerModels = PROVIDER_MODELS[staticAlias] || [];

        return {
          providerId,
          conn,
          staticAlias,
          outputAlias,
          providerModels,
        };
      });

      const resolvedProviderEntries = await resolveProviderModelIds(providerEntries);

      for (const entry of resolvedProviderEntries) {
        for (const modelId of entry.modelIds) {
          models.push({
            id: `${entry.outputAlias}/${modelId}`,
            object: "model",
            created: timestamp,
            owned_by: entry.outputAlias,
            permission: [],
            root: modelId,
            parent: null,
          });
        }
      }
    }

    const payload = {
      object: "list",
      data: models,
    };
    writeFinalModelsResponseCache(finalCacheKey, payload);

    return Response.json(payload, {
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
