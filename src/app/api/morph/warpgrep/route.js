import { dispatchMorphCapability } from "@/app/api/morph/_dispatch.js";
import { getSettings } from "@/lib/localDb.js";

export async function POST(req) {
  const settings = await getSettings();
  const morphSettings = settings?.morph;

  if (!morphSettings?.baseUrl || !Array.isArray(morphSettings.apiKeys) || morphSettings.apiKeys.length === 0) {
    return Response.json({ error: "Morph is not configured" }, { status: 503 });
  }

  return dispatchMorphCapability({
    capability: "warpgrep",
    req,
    morphSettings,
  });
}
