const DEFAULT_CACHE_TTL_MS = 15_000;

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
    },

    async load(machineId, registration = {}, options = {}) {
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

      if (!options.forceRefresh && cacheEntry && currentTime - cacheEntry.fetchedAt < ttlMs) {
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

      const config = mergeEligibleProviders(runtimePayload, eligiblePayload);
      cache.set(cacheKey, {
        config,
        fetchedAt: currentTime,
      });
      return config;
    },
  };
}
