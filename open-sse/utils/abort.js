export const DEFAULT_UPSTREAM_TIMEOUT_MS = 45_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_CHAT_RUNTIME_SETTINGS = Object.freeze({
  upstreamTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
  streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  maxInflight: 2000,
  providerMaxInflight: 600,
  accountMaxInflight: 80,
  observabilityMode: "full",
  observabilitySampleRate: 0.1,
  highThroughputSelection: true,
});

let runtimeSettingsOverride = null;

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseUnitInterval(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

export function normalizeChatRuntimeSettings(settings = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  return {
    upstreamTimeoutMs: parsePositiveInteger(source.upstreamTimeoutMs, DEFAULT_CHAT_RUNTIME_SETTINGS.upstreamTimeoutMs),
    streamIdleTimeoutMs: parsePositiveInteger(source.streamIdleTimeoutMs, DEFAULT_CHAT_RUNTIME_SETTINGS.streamIdleTimeoutMs),
    maxInflight: parsePositiveInteger(source.maxInflight, DEFAULT_CHAT_RUNTIME_SETTINGS.maxInflight),
    providerMaxInflight: parsePositiveInteger(source.providerMaxInflight, DEFAULT_CHAT_RUNTIME_SETTINGS.providerMaxInflight),
    accountMaxInflight: parsePositiveInteger(source.accountMaxInflight, DEFAULT_CHAT_RUNTIME_SETTINGS.accountMaxInflight),
    observabilityMode: ["full", "sampled", "minimal", "off"].includes(source.observabilityMode) ? source.observabilityMode : DEFAULT_CHAT_RUNTIME_SETTINGS.observabilityMode,
    observabilitySampleRate: parseUnitInterval(source.observabilitySampleRate, DEFAULT_CHAT_RUNTIME_SETTINGS.observabilitySampleRate),
    highThroughputSelection: source.highThroughputSelection !== false,
  };
}

export function setChatRuntimeSettings(settings = {}) {
  runtimeSettingsOverride = normalizeChatRuntimeSettings(settings);
  return runtimeSettingsOverride;
}

export function getChatRuntimeSettings() {
  return runtimeSettingsOverride || DEFAULT_CHAT_RUNTIME_SETTINGS;
}

export function getUpstreamTimeoutMs() {
  if (runtimeSettingsOverride) return getChatRuntimeSettings().upstreamTimeoutMs;
  return parsePositiveInteger(process.env.CHAT_UPSTREAM_TIMEOUT_MS, DEFAULT_CHAT_RUNTIME_SETTINGS.upstreamTimeoutMs);
}

export function getStreamIdleTimeoutMs() {
  if (runtimeSettingsOverride) return getChatRuntimeSettings().streamIdleTimeoutMs;
  return parsePositiveInteger(process.env.CHAT_STREAM_IDLE_TIMEOUT_MS, DEFAULT_CHAT_RUNTIME_SETTINGS.streamIdleTimeoutMs);
}

export function getChatObservabilityMode() {
  const sourceMode = runtimeSettingsOverride
    ? getChatRuntimeSettings().observabilityMode
    : process.env.CHAT_OBSERVABILITY_MODE || DEFAULT_CHAT_RUNTIME_SETTINGS.observabilityMode;
  const mode = String(sourceMode).toLowerCase();
  return ["full", "sampled", "minimal", "off"].includes(mode) ? mode : DEFAULT_CHAT_RUNTIME_SETTINGS.observabilityMode;
}

export function getChatObservabilitySampleRate() {
  if (runtimeSettingsOverride) return getChatRuntimeSettings().observabilitySampleRate;
  return parseUnitInterval(process.env.CHAT_OBSERVABILITY_SAMPLE_RATE, DEFAULT_CHAT_RUNTIME_SETTINGS.observabilitySampleRate);
}

export function getHighThroughputSelectionEnabled() {
  if (runtimeSettingsOverride) return getChatRuntimeSettings().highThroughputSelection !== false;
  if (process.env.CHAT_HIGH_THROUGHPUT_SELECTION === "false") return false;
  return DEFAULT_CHAT_RUNTIME_SETTINGS.highThroughputSelection;
}

export function createTimeoutError(timeoutMs, label = "upstream") {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.name = "AbortError";
  error.code = "UPSTREAM_TIMEOUT";
  error.timeoutMs = timeoutMs;
  return error;
}

export function mergeAbortSignals(signals = []) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) return null;
  if (activeSignals.length === 1) return activeSignals[0];
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }

  const controller = new AbortController();
  const abort = (event) => {
    const source = event?.target;
    controller.abort(source?.reason);
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }

  return controller.signal;
}

export function createDeadlineSignal(timeoutMs, label = "upstream") {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(createTimeoutError(timeoutMs, label));
  }, timeoutMs);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}
