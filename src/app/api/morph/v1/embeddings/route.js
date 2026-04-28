import { dispatchMorphCapability } from "@/app/api/morph/_dispatch.js";
import { getConfiguredMorphSettings, logMorphApiAccess } from "@/app/api/morph/_shared.js";

const RAW_MORPH_EMBEDDINGS = { method: "POST", path: "/v1/embeddings" };

export async function POST(req) {
  logMorphApiAccess(req);
  const morphSettings = await getConfiguredMorphSettings();

  if (!morphSettings) {
    return Response.json({ error: "Morph is not configured" }, { status: 503 });
  }

  return dispatchMorphCapability({
    capability: "embeddings",
    req,
    morphSettings,
    upstreamTarget: RAW_MORPH_EMBEDDINGS,
    requestLabel: "morph:/v1/embeddings",
  });
}
