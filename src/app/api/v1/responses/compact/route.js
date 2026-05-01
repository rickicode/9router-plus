import { dispatchMorphCapability } from "@/app/api/morph/_dispatch.js";
import { getSettings } from "@/lib/localDb.js";
import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";

const ANSI_BRIGHT_BLUE = "\x1b[94m";
const ANSI_RESET = "\x1b[0m";

let initialized = false;

function hasUsableMorphKey(morphSettings) {
  return Boolean(
    morphSettings?.baseUrl
      && Array.isArray(morphSettings.apiKeys)
      && morphSettings.apiKeys.some((entry) => entry?.key && entry.status !== "inactive" && entry.isExhausted !== true)
  );
}

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/responses/compact - Compact conversation context
 * Prefer Morph native compact when usable Morph keys exist; otherwise reuse the
 * existing provider/model compact pipeline as a fallback.
 */
export async function POST(request) {
  await ensureInitialized();
  const settings = await getSettings();
  const morphSettings = settings?.morph;

  if (hasUsableMorphKey(morphSettings)) {
    console.log(`${ANSI_BRIGHT_BLUE}[COMPACT] /v1/responses/compact -> Morph native /v1/compact${ANSI_RESET}`);
    return dispatchMorphCapability({
      capability: "compact",
      req: request,
      morphSettings,
      upstreamTarget: { method: "POST", path: "/v1/compact" },
      requestLabel: "morph:/v1/compact",
    });
  }

  console.log(`${ANSI_BRIGHT_BLUE}[COMPACT] /v1/responses/compact -> provider/model fallback${ANSI_RESET}`);
  const body = await request.json();
  body._compact = true;
  const newRequest = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(body)
  });
  return await handleChat(newRequest);
}
