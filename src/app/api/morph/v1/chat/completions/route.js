import { dispatchMorphCapability } from "@/app/api/morph/_dispatch.js";
import { getConfiguredMorphSettings, logMorphApiAccess } from "@/app/api/morph/_shared.js";

const RAW_MORPH_CHAT_COMPLETIONS = { method: "POST", path: "/v1/chat/completions" };

export async function POST(req) {
  logMorphApiAccess(req);
  const morphSettings = await getConfiguredMorphSettings();

  if (!morphSettings) {
    return Response.json({ error: "Morph is not configured" }, { status: 503 });
  }

  return dispatchMorphCapability({
    capability: "apply",
    req,
    morphSettings,
    upstreamTarget: RAW_MORPH_CHAT_COMPLETIONS,
    requestLabel: "morph:/v1/chat/completions",
  });
}
