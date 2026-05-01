import { dispatchMorphCapability } from "@/app/api/morph/_dispatch.js";
import { applyCompactedMessages, buildAutoCompactPlan } from "open-sse/utils/autoCompactCore.js";

function createCompactRequest(originalRequest, requestBody) {
  const originalUrl = originalRequest?.url ? new URL(originalRequest.url) : new URL("http://localhost/morphllm/v1/compact");
  const compactUrl = new URL("/morphllm/v1/compact", originalUrl.origin);

  return new Request(compactUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody,
  });
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

    log?.info?.("COMPACT", `Auto compacted ${plan.messages.length} messages`);
    return compactedBody;
  } catch (error) {
    log?.warn?.("COMPACT", `Auto compact skipped: ${error?.message || error}`);
    return body;
  }
}
