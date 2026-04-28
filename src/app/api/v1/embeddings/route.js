import { routeMorphV1Capability } from "@/app/api/morph/v1Routing.js";
import { handleEmbeddings } from "@/sse/handlers/embeddings.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/embeddings - OpenAI-compatible embeddings endpoint
 */
export async function POST(request) {
  const morphResponse = await routeMorphV1Capability(request, "embeddings");
  if (morphResponse) {
    return morphResponse;
  }

  return await handleEmbeddings(request);
}
