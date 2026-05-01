import { getSettings } from "./localDb.js";

/**
 * Resolve the active cloud worker entry from settings.
 *
 * Returns `null` when no worker has been configured. Callers MUST handle the
 * null case — there is no implicit default URL anymore. The legacy fallback to
 * `http://localhost:8787` and the `NEXT_PUBLIC_CLOUD_URL` / `CLOUD_URL` env
 * vars have been removed so that all configuration lives in the dashboard.
 */
export async function getActiveCloudEntry() {
  const settings = await getSettings();
  if (!Array.isArray(settings.cloudUrls)) return null;

  return (
    settings.cloudUrls.find(
      (entry) => entry?.url
    ) || null
  );
}

export async function getCloudUrl() {
  const entry = await getActiveCloudEntry();
  if (!entry) {
    throw new Error(
      "No cloud worker configured. Add one in Endpoint → Cloud."
    );
  }
  return String(entry.url).replace(/\/$/, "");
}

export async function getCloudCredentials() {
  const settings = await getSettings();
  const entry = await getActiveCloudEntry();
  if (!entry) {
    throw new Error(
      "No cloud worker configured. Add one in Endpoint → Cloud."
    );
  }
  return {
    id: entry.id,
    url: String(entry.url).replace(/\/$/, ""),
    secret: typeof settings.cloudSharedSecret === "string" ? settings.cloudSharedSecret : null
  };
}
