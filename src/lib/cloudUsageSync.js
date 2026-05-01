import { getConsistentMachineId } from "@/shared/utils/machineId";
import { fetchWorkerUsageEvents } from "./cloudWorkerClient.js";
import { atomicUpdateSettings, getSettings, isCloudEnabled } from "./localDb.js";
import { appendRequestLog, saveRequestUsage } from "./usageDb.js";
import { saveMorphUsage } from "./morphUsageDb.js";

const DEFAULT_LIMIT = 500;
const MAX_SEEN_EVENT_IDS_PER_WORKER = 2000;

function getWorkerKey(entry) {
  return entry?.id || entry?.url || "default";
}

function buildEventId(event = {}, worker = {}) {
  return `${getWorkerKey(worker)}:${Number(event.cursor) || 0}`;
}

function getSyncState(settings = {}) {
  const cloudUsageSync = settings?.cloudUsageSync && typeof settings.cloudUsageSync === "object"
    ? settings.cloudUsageSync
    : {};
  return {
    cursorsByWorkerId: cloudUsageSync.cursorsByWorkerId && typeof cloudUsageSync.cursorsByWorkerId === "object"
      ? { ...cloudUsageSync.cursorsByWorkerId }
      : {},
    seenEventIds: cloudUsageSync.seenEventIds && typeof cloudUsageSync.seenEventIds === "object"
      ? Object.fromEntries(
          Object.entries(cloudUsageSync.seenEventIds).map(([workerId, ids]) => [
            workerId,
            Array.isArray(ids) ? ids.slice(-MAX_SEEN_EVENT_IDS_PER_WORKER) : [],
          ])
        )
      : {},
  };
}

async function persistSyncState(syncState) {
  await atomicUpdateSettings((current) => ({
    ...current,
    cloudUsageSync: {
      cursorsByWorkerId: { ...(syncState.cursorsByWorkerId || {}) },
      seenEventIds: Object.fromEntries(
        Object.entries(syncState.seenEventIds || {}).map(([workerId, ids]) => [
          workerId,
          Array.isArray(ids) ? ids.slice(-MAX_SEEN_EVENT_IDS_PER_WORKER) : [],
        ])
      ),
    },
  }));
}

function hasSeenEvent(syncState, workerKey, eventId) {
  return Array.isArray(syncState.seenEventIds?.[workerKey]) && syncState.seenEventIds[workerKey].includes(eventId);
}

function rememberEvent(syncState, workerKey, eventId) {
  const ids = Array.isArray(syncState.seenEventIds?.[workerKey]) ? [...syncState.seenEventIds[workerKey]] : [];
  ids.push(eventId);
  syncState.seenEventIds[workerKey] = ids.slice(-MAX_SEEN_EVENT_IDS_PER_WORKER);
}

function getTokens(event = {}) {
  return {
    prompt_tokens: Number(event.tokensInput) || 0,
    completion_tokens: Number(event.tokensOutput) || 0,
  };
}

function getStatus(event = {}) {
  const status = Number(event.status) || 0;
  if (event.error) return status ? `error:${status}` : "error";
  return status >= 400 ? `error:${status}` : "ok";
}

async function persistWorkerEvent(event = {}, worker = {}) {
  const tokens = getTokens(event);

  if (event.type === "morph" || event.provider === "morph") {
    await saveMorphUsage({
      timestamp: event.timestamp,
      capability: event.endpoint || "morph",
      entrypoint: event.endpoint || "unknown",
      source: "cloud-worker",
      method: "POST",
      model: event.model || null,
      status: getStatus(event),
      upstreamStatus: Number(event.status) || null,
      tokens,
      error: event.error || null,
    });
    return;
  }

  await saveRequestUsage({
    timestamp: event.timestamp,
    provider: event.provider || "unknown",
    model: event.model || "unknown",
    connectionId: event.connectionId || null,
    endpoint: event.endpoint || "cloud-worker",
    cloudWorkerId: getWorkerKey(worker),
    status: getStatus(event),
    tokens,
    error: event.error || null,
  });

  await appendRequestLog({
    model: event.model || "unknown",
    provider: event.provider || "unknown",
    connectionId: event.connectionId || null,
    tokens,
    status: getStatus(event),
  });
}

export async function syncCloudUsageEvents({ settings = null, limit = DEFAULT_LIMIT } = {}) {
  if (!await isCloudEnabled()) {
    return { successes: 0, total: 0, events: 0, skipped: true };
  }

  const resolvedSettings = settings || await getSettings();
  const syncState = getSyncState(resolvedSettings);
  const workers = Array.isArray(resolvedSettings.cloudUrls)
    ? resolvedSettings.cloudUrls.filter((entry) => entry?.url && entry?.secret)
    : [];
  if (workers.length === 0) {
    return { successes: 0, total: 0, events: 0 };
  }

  const machineId = await getConsistentMachineId();
  let successes = 0;
  let eventCount = 0;
  const failures = [];
  let syncStateDirty = false;

  for (const worker of workers) {
    const workerKey = getWorkerKey(worker);
    const cursor = Number(syncState.cursorsByWorkerId?.[workerKey]) || 0;

    try {
      const result = await fetchWorkerUsageEvents(worker.url, worker.secret, machineId, { cursor, limit });
      const events = Array.isArray(result.events) ? result.events : [];
      for (const event of events) {
        const eventId = buildEventId(event, worker);
        if (hasSeenEvent(syncState, workerKey, eventId)) {
          continue;
        }

        await persistWorkerEvent(event, worker);
        rememberEvent(syncState, workerKey, eventId);
        syncStateDirty = true;
        eventCount += 1;
      }

      if (Number.isFinite(Number(result.nextCursor))) {
        syncState.cursorsByWorkerId[workerKey] = Number(result.nextCursor);
        syncStateDirty = true;
      } else if (events.length > 0) {
        syncState.cursorsByWorkerId[workerKey] = Number(events.at(-1).cursor) || cursor;
        syncStateDirty = true;
      }

      successes += 1;
    } catch (error) {
      failures.push(`${worker.url}: ${error?.message || "unknown error"}`);
    }
  }

  if (syncStateDirty) {
    await persistSyncState(syncState);
  }

  return {
    successes,
    total: workers.length,
    events: eventCount,
    failures,
  };
}
