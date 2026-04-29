import { getChatRuntimeSettings } from "open-sse/utils/abort.js";

const counters = {
  global: 0,
  provider: new Map(),
  account: new Map(),
};

function parseLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getLimits(overrides = null) {
  const runtimeSettings = overrides || getChatRuntimeSettings();
  return {
    global: parseLimit(runtimeSettings.maxInflight, 2000),
    provider: parseLimit(runtimeSettings.providerMaxInflight, 600),
    account: parseLimit(runtimeSettings.accountMaxInflight, 80),
  };
}

function getCount(map, key) {
  return map.get(key) || 0;
}

function increment(map, key) {
  map.set(key, getCount(map, key) + 1);
}

function decrement(map, key) {
  const next = Math.max(0, getCount(map, key) - 1);
  if (next === 0) map.delete(key);
  else map.set(key, next);
}

export function tryAcquireChatSlot({ provider = "unknown", connectionId = "unknown", limits = null } = {}) {
  const resolvedLimits = getLimits(limits);
  const providerKey = provider || "unknown";
  const accountKey = connectionId || "unknown";
  const providerCount = getCount(counters.provider, providerKey);
  const accountCount = getCount(counters.account, accountKey);

  if (counters.global >= resolvedLimits.global) {
    return { ok: false, status: 503, reason: "Global chat concurrency limit reached" };
  }
  if (providerCount >= resolvedLimits.provider) {
    return { ok: false, status: 503, reason: `Provider ${providerKey} concurrency limit reached` };
  }
  if (accountCount >= resolvedLimits.account) {
    return { ok: false, status: 429, reason: `Account ${accountKey} concurrency limit reached` };
  }

  counters.global += 1;
  increment(counters.provider, providerKey);
  increment(counters.account, accountKey);

  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      counters.global = Math.max(0, counters.global - 1);
      decrement(counters.provider, providerKey);
      decrement(counters.account, accountKey);
    },
  };
}

export function attachChatSlotRelease(response, release) {
  if (!response || typeof release !== "function") {
    return response;
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    release();
    return response;
  }

  const reader = response.body.getReader();
  let released = false;
  const safeRelease = () => {
    if (released) return;
    released = true;
    release();
  };

  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          safeRelease();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        safeRelease();
        controller.error(error);
      }
    },
    async cancel(reason) {
      safeRelease();
      await reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function getChatLimiterSnapshot() {
  return {
    global: counters.global,
    provider: new Map(counters.provider),
    account: new Map(counters.account),
  };
}

export function resetChatLimiterForTests() {
  counters.global = 0;
  counters.provider.clear();
  counters.account.clear();
}
