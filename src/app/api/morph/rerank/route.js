import { dispatchMorphCapability } from "@/app/api/morph/_dispatch.js";
import { getConfiguredMorphSettings, logMorphApiAccess } from "@/app/api/morph/_shared.js";

export async function POST(req) {
  logMorphApiAccess(req);
  const morphSettings = await getConfiguredMorphSettings();

  if (!morphSettings) {
    return Response.json({ error: "Morph is not configured" }, { status: 503 });
  }

  return dispatchMorphCapability({
    capability: "rerank",
    req,
    morphSettings,
  });
}
