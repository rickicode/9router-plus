/**
 * Legacy helpers for the old per-machineId chat path on the Cloudflare Worker.
 *
 * The dashboard now drives all cloud configuration; the env-based fallback
 * (`NEXT_PUBLIC_CLOUD_URL`) has been removed. These helpers stay for the
 * occasional caller that still references them, but they only work when a
 * cloud URL has been configured in the dashboard via Endpoint → Cloud.
 */
import { getMachineId } from "@/shared/utils/machine";
import { getCloudUrl as resolveCloudUrl } from "@/lib/cloudUrlResolver";

/**
 * Build the legacy `/{machineId}/v1/chat/completions` URL for a configured
 * cloud worker. Throws if no worker has been configured.
 */
export async function getCloudChatUrl(machineId) {
  const base = await resolveCloudUrl();
  return `${base}/${machineId}/v1/chat/completions`;
}

export async function callCloudWithMachineId(request) {
  const machineId = await getMachineId();
  if (!machineId) {
    throw new Error("Could not get machine ID");
  }

  const cloudUrl = await getCloudChatUrl(machineId);
  const body = await request.json();
  const headers = new Headers(request.headers);
  headers.delete("authorization");

  return fetch(cloudUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// Frontend periodic sync was retired; the new sync flow lives in
// `src/lib/cloudSync.js` and is triggered by the dashboard server-side.
export function startProviderSync() {
  console.log("Frontend sync is disabled. Use backend sync instead.");
  return null;
}
