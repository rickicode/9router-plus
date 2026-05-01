const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_FULL_RUNTIME_KEY = "runtime/" + "credentials.full.json";
const DEFAULT_RUNTIME_CONFIG_KEY = "runtime/runtime.config.json";

function defaultFetchImpl(...args) {
  return fetch(...args);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isValidRuntimeConfig(value) {
  return (
    isPlainObject(value) &&
    isPlainObject(value.providers) &&
    isPlainObject(value.modelAliases) &&
    Array.isArray(value.combos) &&
    Array.isArray(value.apiKeys) &&
    isPlainObject(value.settings)
  );
}

function isValidEligibleRuntimeConfig(value) {
  return isPlainObject(value) && isPlainObject(value.providers);
}

function isValidFullCredentialsArtifact(value) {
  return isPlainObject(value) && isPlainObject(value.providers);
}

function isValidRuntimeConfigArtifact(value) {
  return (
    isPlainObject(value) &&
    isPlainObject(value.modelAliases) &&
    Array.isArray(value.combos) &&
    Array.isArray(value.apiKeys) &&
    isPlainObject(value.settings)
  );
}

function resolveR2ObjectKey(env, envName, fallback) {
  const value = typeof env?.[envName] === "string" ? env[envName].trim() : "";
  return value || fallback;
}

function getRuntimeBucket(env) {
  return env?.R2_RUNTIME || null;
}

async function readR2Json(bucket, key) {
  const object = await bucket.get(key);
  if (!object) {
    throw new Error(`Missing R2 runtime artifact: ${key}`);
  }

  try {
    return await object.json();
  } catch {
    throw new Error(`Invalid JSON in R2 runtime artifact: ${key}`);
  }
}

function mergePrivateRuntimeArtifacts(credentialsArtifact, runtimeConfigArtifact) {
  const settings = {
    ...(runtimeConfigArtifact.settings || {}),
  };

  if (credentialsArtifact.morph) {
    settings.morph = credentialsArtifact.morph;
  }

  return {
    generatedAt: credentialsArtifact.generatedAt || runtimeConfigArtifact.generatedAt || new Date().toISOString(),
    credentialsGeneratedAt: credentialsArtifact.generatedAt || null,
    runtimeConfigGeneratedAt: runtimeConfigArtifact.generatedAt || null,
    strategy: runtimeConfigArtifact.strategy || settings.strategy || "priority",
    providers: credentialsArtifact.providers || {},
    modelAliases: runtimeConfigArtifact.modelAliases || {},
    combos: runtimeConfigArtifact.combos || [],
    apiKeys: runtimeConfigArtifact.apiKeys || [],
    settings,
  };
}

function getRuntimeConfigUrl(runtimeUrl) {
  return new URL("runtime.json", runtimeUrl.endsWith("/") ? runtimeUrl : `${runtimeUrl}/`).toString();
}

function getEligibleConfigUrl(runtimeUrl) {
  return new URL("eligible.json", runtimeUrl.endsWith("/") ? runtimeUrl : `${runtimeUrl}/`).toString();
}

function getTransientFetchError(response) {
  if (response.status >= 500) {
    return new Error(`Runtime config fetch failed with status ${response.status}`);
  }

  return null;
}

async function readJsonResponse(response, errorMessage) {
  try {
    return await response.json();
  } catch {
    throw new Error(errorMessage);
  }
}

function mergeEligibleProviders(runtimePayload, eligiblePayload) {
  if (!eligiblePayload) {
    return runtimePayload;
  }

  return {
    ...runtimePayload,
    providers: eligiblePayload.providers,
  };
}

export function createRuntimeConfigLoader({ fetchImpl = defaultFetchImpl, now = () => Date.now() } = {}) {
  const cache = new Map();

  return {
    invalidate(machineId, registration = {}) {
      const runtimeUrl = registration?.runtimeUrl;
      if (!runtimeUrl) {
        for (const key of cache.keys()) {
          if (key.startsWith(`${machineId}:`)) {
            cache.delete(key);
          }
        }
        return;
      }

      cache.delete(`${machineId}:${runtimeUrl}`);
      for (const key of cache.keys()) {
        if (key.startsWith(`${machineId}:r2:`)) {
          cache.delete(key);
        }
      }
    },

    async load(machineId, registration = {}, options = {}) {
      const env = options.env || null;
      const bucket = getRuntimeBucket(env);
      const fullRuntimeEnvName = ["R2", "RUNTIME", "FULL", "KEY"].join("_");
      const runtimeConfigEnvName = ["R2", "RUNTIME", "CONFIG", "KEY"].join("_");
      const fullRuntimeObjectKey = resolveR2ObjectKey(env, fullRuntimeEnvName, DEFAULT_FULL_RUNTIME_KEY);
      const runtimeConfigKey = resolveR2ObjectKey(env, runtimeConfigEnvName, DEFAULT_RUNTIME_CONFIG_KEY);

      if (bucket) {
        const cacheKey = `${machineId}:r2:${fullRuntimeObjectKey}:${runtimeConfigKey}`;
        const ttlMs = Number.isFinite(registration.cacheTtlMs)
          ? Math.max(0, registration.cacheTtlMs)
          : DEFAULT_CACHE_TTL_MS;
        const cacheEntry = cache.get(cacheKey);
        const currentTime = now();

        if (!options.forceRefresh && cacheEntry && currentTime - cacheEntry.fetchedAt < ttlMs) {
          return cacheEntry.config;
        }

        try {
          const [credentialsPayload, runtimeConfigPayload] = await Promise.all([
            readR2Json(bucket, fullRuntimeObjectKey),
            readR2Json(bucket, runtimeConfigKey),
          ]);

          if (!isValidFullCredentialsArtifact(credentialsPayload)) {
            throw new Error("Invalid full credentials artifact payload");
          }
          if (!isValidRuntimeConfigArtifact(runtimeConfigPayload)) {
            throw new Error("Invalid runtime config artifact payload");
          }

          const mergedPayload = mergePrivateRuntimeArtifacts(credentialsPayload, runtimeConfigPayload);
          cache.set(cacheKey, {
            config: mergedPayload,
            fetchedAt: currentTime,
          });
          return mergedPayload;
        } catch (error) {
          if (cacheEntry) {
            return cacheEntry.config;
          }
          throw error;
        }
      }

      const runtimeUrl = registration?.runtimeUrl;
      if (!runtimeUrl) {
        return null;
      }

      const cacheKey = `${machineId}:${runtimeUrl}`;
      const ttlMs = Number.isFinite(registration.cacheTtlMs)
        ? Math.max(0, registration.cacheTtlMs)
        : DEFAULT_CACHE_TTL_MS;
      const cacheEntry = cache.get(cacheKey);
      const currentTime = now();

      if (cacheEntry && currentTime - cacheEntry.fetchedAt < ttlMs) {
        return cacheEntry.config;
      }

      let runtimeResponse;
      try {
        runtimeResponse = await fetchImpl(getRuntimeConfigUrl(runtimeUrl));
      } catch (error) {
        if (cacheEntry) {
          return cacheEntry.config;
        }
        throw error;
      }

      const transientError = getTransientFetchError(runtimeResponse);
      if (transientError) {
        if (cacheEntry) {
          return cacheEntry.config;
        }
        throw transientError;
      }

      if (!runtimeResponse.ok) {
        throw new Error(`Runtime config fetch failed with status ${runtimeResponse.status}`);
      }

      const runtimePayload = await readJsonResponse(runtimeResponse, "Invalid runtime config payload");
      if (!isValidRuntimeConfig(runtimePayload)) {
        throw new Error("Invalid runtime config payload");
      }

      let eligiblePayload = null;
      let eligibleResponse;
      try {
        eligibleResponse = await fetchImpl(getEligibleConfigUrl(runtimeUrl));
      } catch (error) {
        if (cacheEntry) {
          return cacheEntry.config;
        }
        throw error;
      }

      const eligibleTransientError = getTransientFetchError(eligibleResponse);
      if (eligibleTransientError) {
        if (cacheEntry) {
          return cacheEntry.config;
        }
        throw eligibleTransientError;
      }

      if (eligibleResponse.status !== 404) {
        if (!eligibleResponse.ok) {
          throw new Error(`Eligible runtime fetch failed with status ${eligibleResponse.status}`);
        }

        eligiblePayload = await readJsonResponse(eligibleResponse, "Invalid eligible runtime payload");
        if (!isValidEligibleRuntimeConfig(eligiblePayload)) {
          throw new Error("Invalid eligible runtime payload");
        }
      }

      const mergedPayload = mergeEligibleProviders(runtimePayload, eligiblePayload);

      cache.set(cacheKey, {
        config: mergedPayload,
        fetchedAt: currentTime
      });

      return mergedPayload;
    }
  };
}
