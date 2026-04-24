import { getSettings } from "./localDb.js";

export async function getCloudUrl() {
  const envUrl = process.env.NEXT_PUBLIC_CLOUD_URL;
  if (envUrl) return envUrl.replace(/\/$/, "");

  const settings = await getSettings();
  const firstUrl = settings.cloudUrls?.[0]?.url;
  if (firstUrl && typeof firstUrl === "string") {
    return firstUrl.replace(/\/$/, "");
  }

  return "http://localhost:8787";
}
