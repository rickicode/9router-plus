const DEFAULT_CACHE_TTL_MS = 15_000;

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

function getRuntimeConfigUrl(runtimeUrl) {
  return new URL("runtime.json", runtimeUrl.endsWith("/") ? runtimeUrl : `${runtimeUrl}/`).toString();
}

function getTransientFetchError(response) {
  if (response.status >= 500) {
    return new Error(`Runtime config fetch failed with status ${response.status}`);
  }

  return null;
}

export function createRuntimeConfigLoader({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const cache = new Map();

  return {
    async load(machineId, registration = {}) {
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

      let response;
      try {
        response = await fetchImpl(getRuntimeConfigUrl(runtimeUrl));
      } catch (error) {
        if (cacheEntry) {
          return cacheEntry.config;
        }
        throw error;
      }

      const transientError = getTransientFetchError(response);
      if (transientError) {
        if (cacheEntry) {
          return cacheEntry.config;
        }
        throw transientError;
      }

      if (!response.ok) {
        throw new Error(`Runtime config fetch failed with status ${response.status}`);
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Invalid runtime config payload");
      }

      if (!isValidRuntimeConfig(payload)) {
        throw new Error("Invalid runtime config payload");
      }

      cache.set(cacheKey, {
        config: payload,
        fetchedAt: currentTime
      });

      return payload;
    }
  };
}
