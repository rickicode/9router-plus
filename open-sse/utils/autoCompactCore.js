export const DEFAULT_AUTO_COMPACT_SETTINGS = Object.freeze({
  enabled: false,
  minMessages: 20,
  compressionRatio: 0.5,
});
const PRESERVE_RECENT = 3;

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

export function normalizeAutoCompactSettings(settings = {}) {
  const source = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const compressionRatio = Number(source.compressionRatio);
  return {
    enabled: source.enabled === true,
    minMessages: normalizePositiveInteger(source.minMessages, DEFAULT_AUTO_COMPACT_SETTINGS.minMessages),
    compressionRatio: Number.isFinite(compressionRatio) && compressionRatio >= 0.05 && compressionRatio <= 1
      ? compressionRatio
      : DEFAULT_AUTO_COMPACT_SETTINGS.compressionRatio,
  };
}

export function getDefaultAutoCompactSettings() {
  return { ...DEFAULT_AUTO_COMPACT_SETTINGS };
}

function getMessageItems(body) {
  if (Array.isArray(body?.messages)) return { key: "messages", items: body.messages };
  if (Array.isArray(body?.input)) return { key: "input", items: body.input };
  return { key: null, items: [] };
}

function getCurrentUserQuery(items) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const message = items[index];
    if (message?.role === "user" && typeof message.content === "string" && message.content.trim()) {
      return message.content;
    }
    if (message?.role === "user") return "";
  }
  return "";
}

export function buildAutoCompactPlan(body, settings = {}) {
  const autoCompact = normalizeAutoCompactSettings(settings);
  if (!autoCompact.enabled) return { ok: false, reason: "disabled" };

  const { key, items } = getMessageItems(body);
  if (!key) return { ok: false, reason: "no messages" };
  if (items.length < autoCompact.minMessages) return { ok: false, reason: "below minimum messages" };

  const messages = [];
  const entries = [];
  for (const [index, message] of items.entries()) {
    if (!message || typeof message !== "object" || typeof message.content !== "string" || !message.content) {
      return { ok: false, reason: "request messages are not all plain text" };
    }
    const compactMessage = {
      role: typeof message.role === "string" ? message.role : "user",
      content: message.content,
    };
    messages.push(compactMessage);
    entries.push({ index, message: compactMessage });
  }

  const query = getCurrentUserQuery(items);
  if (!query) return { ok: false, reason: "current user query is not plain text" };

  return {
    ok: true,
    key,
    entries,
    messages,
    payload: {
      messages,
      query,
      compression_ratio: autoCompact.compressionRatio,
      preserve_recent: PRESERVE_RECENT,
      include_line_ranges: false,
      include_markers: false,
    },
  };
}

export function applyCompactedMessages(body, key, entries, compactedMessages) {
  if (!key || compactedMessages.length !== entries.length) return null;

  const originalItems = Array.isArray(body?.[key]) ? body[key] : [];
  const nextItems = [...originalItems];
  for (const [entryIndex, entry] of entries.entries()) {
    const compactedContent = compactedMessages[entryIndex]?.content;
    if (typeof compactedContent !== "string") return null;
    nextItems[entry.index] = {
      ...originalItems[entry.index],
      content: compactedContent,
    };
  }

  return { ...body, [key]: nextItems };
}
