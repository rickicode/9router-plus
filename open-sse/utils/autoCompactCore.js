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

function extractPlainTextContent(content) {
  if (typeof content === "string") {
    return content.trim() ? content : "";
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text);
      continue;
    }

    if (item.type === "input_text" && typeof item.text === "string" && item.text.trim()) {
      parts.push(item.text);
    }
  }

  return parts.join("\n\n").trim();
}

function getCurrentUserQuery(items) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const message = items[index];
    if (message?.role !== "user") {
      continue;
    }

    const text = extractPlainTextContent(message.content);
    return text || "";
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
    if (!message || typeof message !== "object") {
      return { ok: false, reason: "request messages are not compactable" };
    }

    const textContent = extractPlainTextContent(message.content);
    if (!textContent) {
      return { ok: false, reason: "request messages are not compactable" };
    }

    const compactMessage = {
      role: typeof message.role === "string" ? message.role : "user",
      content: textContent,
    };
    messages.push(compactMessage);
    entries.push({ index, message: compactMessage, content: message.content });
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

function applyCompactedContentShape(originalContent, compactedContent) {
  if (typeof originalContent === "string") {
    return compactedContent;
  }

  if (!Array.isArray(originalContent)) {
    return compactedContent;
  }

  let replaced = false;
  const nextContent = originalContent.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }

    if (!replaced && item.type === "text") {
      replaced = true;
      return { ...item, text: compactedContent };
    }

    if (!replaced && item.type === "input_text") {
      replaced = true;
      return { ...item, text: compactedContent };
    }

    return item;
  });

  return replaced ? nextContent : compactedContent;
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
      content: applyCompactedContentShape(entry.content, compactedContent),
    };
  }

  return { ...body, [key]: nextItems };
}
