import { dispatchMorphCapability } from "@/app/api/morph/_dispatch.js";
import { saveMorphUsage } from "@/lib/morphUsageDb.js";
import { applyCompactedMessages, buildAutoCompactPlan } from "open-sse/utils/autoCompactCore.js";

const ANSI_BRIGHT_BLUE = "\x1b[94m";
const ANSI_RESET = "\x1b[0m";

function createCompactRequest(originalRequest, requestBody) {
  const originalUrl = originalRequest?.url ? new URL(originalRequest.url) : new URL("http://localhost/morphllm/v1/compact");
  const compactUrl = new URL("/morphllm/v1/compact", originalUrl.origin);

  return new Request(compactUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody,
  });
}

function estimateTokensFromText(text) {
  const chars = typeof text === "string" ? text.length : 0;
  return Math.max(0, Math.round(chars / 4));
}

function summarizeCompactEffect(messages = [], compactedMessages = [], compressionRatioTarget = 0) {
  const originalText = messages.map((message) => message?.content || "").join("\n");
  const compactedText = compactedMessages.map((message) => message?.content || "").join("\n");
  const originalChars = originalText.length;
  const compactedChars = compactedText.length;
  const originalTokensEstimate = estimateTokensFromText(originalText);
  const compactedTokensEstimate = estimateTokensFromText(compactedText);
  const savedTokensEstimate = Math.max(0, originalTokensEstimate - compactedTokensEstimate);
  const savedChars = Math.max(0, originalChars - compactedChars);
  const reductionPercent = originalTokensEstimate > 0
    ? Number(((savedTokensEstimate / originalTokensEstimate) * 100).toFixed(2))
    : 0;

  return {
    applied: true,
    originalMessageCount: messages.length,
    compactedMessageCount: compactedMessages.length,
    originalChars,
    compactedChars,
    savedChars,
    originalTokensEstimate,
    compactedTokensEstimate,
    savedTokensEstimate,
    reductionPercent,
    compressionRatioTarget: Number(compressionRatioTarget) || 0,
  };
}

function summarizeCompactBody(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
  const toolCount = Array.isArray(body?.tools) ? body.tools.length : 0;
  return {
    messages: messages.length,
    tools: toolCount,
    inputFormat: Array.isArray(body?.input),
  };
}

export async function maybeAutoCompactChatBody({ body, settings, request, log }) {
  const plan = buildAutoCompactPlan(body, settings?.autoCompact);
  if (!plan.ok) {
    if (plan.reason !== "disabled" && plan.reason !== "below minimum messages") {
      log?.warn?.("COMPACT", `Auto compact skipped: ${plan.reason}`);
    }
    return body;
  }

  const morphSettings = settings?.morph;
  if (!morphSettings?.baseUrl || !Array.isArray(morphSettings.apiKeys) || morphSettings.apiKeys.length === 0) {
    log?.warn?.("COMPACT", "Auto compact skipped: Morph is not configured");
    return body;
  }

  const requestBody = JSON.stringify(plan.payload);
  log?.info?.("COMPACT", `Auto compact starting for ${plan.messages.length} messages`, summarizeCompactBody(body));
  console.log(`${ANSI_BRIGHT_BLUE}[COMPACT] auto-compact -> Morph native /v1/compact | messages=${plan.messages.length}${ANSI_RESET}`);

  try {
    const response = await dispatchMorphCapability({
      capability: "compact",
      req: createCompactRequest(request, requestBody),
      morphSettings,
      requestBody,
      requestPayload: plan.payload,
      requestLabel: "morph:auto-compact",
    });

    if (!response.ok) {
      log?.warn?.("COMPACT", `Auto compact skipped: Morph returned ${response.status}`);
      return body;
    }

    const result = await response.json();
    if (!Array.isArray(result?.messages) || result.messages.length === 0) {
      log?.warn?.("COMPACT", "Auto compact skipped: Morph returned no messages");
      return body;
    }

    const compactedBody = applyCompactedMessages(body, plan.key, plan.entries, result.messages);
    if (!compactedBody) {
      log?.warn?.("COMPACT", "Auto compact skipped: Morph returned incompatible message shape");
      return body;
    }

    const autoCompactStats = summarizeCompactEffect(plan.messages, result.messages, plan.payload.compression_ratio);
    await saveMorphUsage({
      capability: "auto-compact",
      entrypoint: "/internal/auto-compact",
      source: "local-auto-compact",
      method: "POST",
      status: "ok",
      category: "auto_compact",
      autoCompactStats,
      tokens: { input_tokens: 0, output_tokens: 0 },
    });

    log?.info?.("COMPACT", `Auto compact completed for ${plan.messages.length} messages`, {
      ...summarizeCompactBody(compactedBody),
      compressionRatio: plan.payload.compression_ratio,
      savedTokensEstimate: autoCompactStats.savedTokensEstimate,
      reductionPercent: autoCompactStats.reductionPercent,
    });
    console.log(`${ANSI_BRIGHT_BLUE}[COMPACT] auto-compact completed | messages=${plan.messages.length} | reduction=${autoCompactStats.reductionPercent}%${ANSI_RESET}`);
    return compactedBody;
  } catch (error) {
    console.warn(`${ANSI_BRIGHT_BLUE}[COMPACT] auto-compact failed | ${error?.message || error}${ANSI_RESET}`);
    log?.warn?.("COMPACT", `Auto compact skipped: ${error?.message || error}`);
    return body;
  }
}
