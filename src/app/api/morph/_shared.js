import { getSettings } from "@/lib/localDb.js";

function getMorphPath(request) {
  if (!request) {
    return "/morphllm";
  }

  if (request?.nextUrl?.pathname) {
    return request.nextUrl.pathname;
  }

  if (typeof request.url === "string" && request.url.length > 0) {
    return new URL(request.url).pathname;
  }

  return "/morphllm";
}

export function logMorphApiAccess(request) {
  const pathname = getMorphPath(request);
  if (!pathname.startsWith("/morphllm")) {
    return pathname;
  }

  console.log(`[morph] access ${request?.method || "GET"} ${pathname}`);
  return pathname;
}

export async function getConfiguredMorphSettings() {
  const settings = await getSettings();
  const morphSettings = settings?.morph;

  if (!morphSettings?.baseUrl || !Array.isArray(morphSettings.apiKeys) || morphSettings.apiKeys.length === 0) {
    return null;
  }

  return morphSettings;
}
