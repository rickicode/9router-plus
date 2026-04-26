/**
 * In-process API routing latency tracker.
 *
 * Records the wall-clock time spent by 9router-plus internally routing a
 * request — i.e. the overhead added by 9router-plus itself, NOT the
 * provider's response time. This gives a direct, honest signal of how
 * snappy the router is.
 *
 * Storage:
 *   - Recent samples kept in a ring buffer (in-memory only).
 *   - On every record, we update lightweight counters that survive across
 *     calls but reset on process restart. That is intentional: the sidebar
 *     widget is meant to reflect "how is the router behaving right now".
 *
 * Public surface:
 *   recordRoutingLatency({ ms, providerId?, status? })
 *   getRoutingLatencySummary({ windowMs? }) -> {
 *     p50, p95, p99, avg, max, min, count, errorCount, lastMs, sampledFromMs
 *   }
 */

const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SAMPLES = 2048;

const samples = []; // ring buffer of { t, ms, status }
let cursor = 0;
let totalCount = 0;
let totalErrorCount = 0;
let lastMs = null;
let lastAt = 0;

function pushSample(sample) {
  if (samples.length < MAX_SAMPLES) {
    samples.push(sample);
  } else {
    samples[cursor] = sample;
    cursor = (cursor + 1) % MAX_SAMPLES;
  }
}

export function recordRoutingLatency({ ms, providerId = null, status = "ok" } = {}) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;

  const sample = {
    t: Date.now(),
    ms,
    status,
    providerId: providerId || null,
  };

  pushSample(sample);
  totalCount += 1;
  if (status !== "ok") totalErrorCount += 1;
  lastMs = ms;
  lastAt = sample.t;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function getRoutingLatencySummary({ windowMs = DEFAULT_WINDOW_MS } = {}) {
  const now = Date.now();
  const cutoff = now - Math.max(0, Number(windowMs) || DEFAULT_WINDOW_MS);
  const windowed = samples.filter((s) => s.t >= cutoff);

  // Compute earliest timestamp BEFORE sorting by latency, otherwise
  // sampledFromMs would point to the smallest-latency sample instead of the
  // oldest sample within the window.
  let earliestT = null;
  let errorCount = 0;
  for (const s of windowed) {
    if (earliestT === null || s.t < earliestT) earliestT = s.t;
    if (s.status !== "ok") errorCount += 1;
  }

  const sortedMs = windowed.map((s) => s.ms).sort((a, b) => a - b);
  const count = sortedMs.length;

  let avg = null;
  let sum = 0;
  for (const ms of sortedMs) sum += ms;
  if (count > 0) avg = sum / count;

  return {
    p50: quantile(sortedMs, 0.5),
    p95: quantile(sortedMs, 0.95),
    p99: quantile(sortedMs, 0.99),
    avg,
    min: count > 0 ? sortedMs[0] : null,
    max: count > 0 ? sortedMs[count - 1] : null,
    count,
    errorCount,
    totalCount,
    totalErrorCount,
    lastMs,
    lastAt,
    windowMs: Math.max(0, Number(windowMs) || DEFAULT_WINDOW_MS),
    sampledFromMs: earliestT,
  };
}

export function __resetRoutingLatencyForTests() {
  samples.length = 0;
  cursor = 0;
  totalCount = 0;
  totalErrorCount = 0;
  lastMs = null;
  lastAt = 0;
}

/**
 * Convenience wrapper: time a function and record the result.
 *
 *   const result = await measureRouting(async () => doWork(), { providerId });
 */
export async function measureRouting(fn, { providerId = null } = {}) {
  const start = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - start;
    recordRoutingLatency({ ms, providerId, status: "ok" });
    return result;
  } catch (error) {
    const ms = Date.now() - start;
    recordRoutingLatency({ ms, providerId, status: "error" });
    throw error;
  }
}
