import { dispatchMorphCapability } from "@/app/api/morph/_dispatch.js";
import { getSettings } from "@/lib/localDb.js";

function isMorphModelValue(model) {
  return typeof model === "string" && /^morph-/i.test(model.trim());
}

export async function routeMorphV1Capability(req, capability) {
  const requestBody = await req.clone().text().catch(() => "");
  let requestPayload = null;

  if (requestBody) {
    try {
      requestPayload = JSON.parse(requestBody);
    } catch {
      requestPayload = null;
    }
  }

  if (!isMorphModelValue(requestPayload?.model)) {
    return null;
  }

  const settings = await getSettings();
  const morphSettings = settings?.morph;

  if (!morphSettings?.baseUrl || !Array.isArray(morphSettings.apiKeys) || morphSettings.apiKeys.length === 0) {
    return Response.json({ error: "Morph is not configured" }, { status: 503 });
  }

  return dispatchMorphCapability({
    capability,
    req,
    morphSettings,
    requestBody,
    requestPayload,
  });
}

export { isMorphModelValue };
