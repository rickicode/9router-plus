import { callCloudWithMachineId } from "@/shared/utils/cloud.js";
import { routeMorphV1Capability } from "@/app/api/morph/v1Routing.js";
import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";

let initialized = false;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
    console.log("[SSE] Translators initialized");
  }
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

export async function POST(request) {
  const morphResponse = await routeMorphV1Capability(request, "apply");
  if (morphResponse) {
    return morphResponse;
  }

  // Fallback to local handling
  await ensureInitialized();

  return await handleChat(request);
}

