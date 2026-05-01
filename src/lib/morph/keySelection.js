const morphRotationCursors = new Map();

const RETRYABLE_STATUS_CODES = new Set([401, 429]);

function isUsableMorphKey(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (entry.isExhausted === true) return false;
  if (entry.status === "inactive") return false;
  return typeof entry.key === "string" && entry.key.trim().length > 0;
}

function normalizeMorphApiKeys(apiKeys = []) {
  if (!Array.isArray(apiKeys)) return [];

  return apiKeys.filter((entry) => isUsableMorphKey(entry));
}

function normalizeRotationKey(rotationKey) {
  return typeof rotationKey === "string" && rotationKey.trim()
    ? rotationKey.trim()
    : "default";
}

export function resetMorphKeySelectionState(rotationKey) {
  if (rotationKey === undefined) {
    morphRotationCursors.clear();
    return;
  }

  morphRotationCursors.delete(normalizeRotationKey(rotationKey));
}

export function getMorphKeySelectionSnapshot() {
  return new Map(morphRotationCursors);
}

export function isMorphRetryableStatus(status) {
  return RETRYABLE_STATUS_CODES.has(status) || status >= 500;
}

export function createMorphDispatchError(message, options = {}) {
  const error = options.cause instanceof Error
    ? new Error(message, { cause: options.cause })
    : new Error(message);

  if (options.name) error.name = options.name;
  if (options.status !== undefined) error.status = options.status;
  if (options.code !== undefined) error.code = options.code;
  if (options.dispatchStarted !== undefined) {
    error.dispatchStarted = options.dispatchStarted;
  }

  return error;
}

export function isMorphRetryableError(error) {
  if (!error || error.dispatchStarted !== true) return false;
  if (typeof error.status === "number") return isMorphRetryableStatus(error.status);

  return true;
}

export function getMorphKeyOrder({ apiKeys = [], roundRobinEnabled = false, rotationKey } = {}) {
  const normalizedKeys = normalizeMorphApiKeys(apiKeys);

  if (normalizedKeys.length === 0) {
    return { startIndex: -1, keyOrder: [] };
  }

  const normalizedRotationKey = normalizeRotationKey(rotationKey);
  const startIndex = roundRobinEnabled === true
    ? (morphRotationCursors.get(normalizedRotationKey) || 0) % normalizedKeys.length
    : 0;

  const keyOrder = normalizedKeys.map((_, offset) => {
    const index = (startIndex + offset) % normalizedKeys.length;
    const selected = normalizedKeys[index];
    return {
      apiKey: selected.key,
      email: selected.email || null,
      status: selected.status || "unknown",
      isExhausted: selected.isExhausted === true,
      index,
      attempt: offset,
    };
  });

  if (roundRobinEnabled === true) {
    morphRotationCursors.set(normalizedRotationKey, (startIndex + 1) % normalizedKeys.length);
  } else {
    morphRotationCursors.set(normalizedRotationKey, 0);
  }

  return { startIndex, keyOrder };
}

export async function executeWithMorphKeyFailover({
  apiKeys = [],
  roundRobinEnabled = false,
  rotationKey,
  execute,
} = {}) {
  const { startIndex, keyOrder } = getMorphKeyOrder({ apiKeys, roundRobinEnabled, rotationKey });

  if (keyOrder.length === 0) {
    const error = new Error("Morph proxy requires at least one usable API key");
    error.code = "MORPH_API_KEY_MISSING";
    throw error;
  }

  if (typeof execute !== "function") {
    throw new Error("Morph key failover requires an execute function");
  }

  let lastFailure = null;

  for (const attemptDetails of keyOrder) {
    try {
      const result = await execute({
        ...attemptDetails,
        startIndex,
        totalKeys: keyOrder.length,
      });

      if (result?.ok === false && isMorphRetryableStatus(result.status) && attemptDetails.attempt < keyOrder.length - 1) {
        lastFailure = createMorphDispatchError(
          `Morph upstream retryable response: ${result.status}`,
          {
            status: result.status,
            dispatchStarted: true,
          }
        );
        continue;
      }

      return result;
    } catch (error) {
      lastFailure = error;

      if (!isMorphRetryableError(error) || attemptDetails.attempt >= keyOrder.length - 1) {
        throw error;
      }
    }
  }

  throw lastFailure || new Error("Morph upstream request failed");
}
