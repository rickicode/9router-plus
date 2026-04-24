import crypto from "crypto";
import { getSettings, updateSettings } from "@/lib/localDb";

/**
 * Generate a secure random token
 */
export function generateProxyToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Get or create internal proxy tokens
 */
export async function getInternalProxyTokens() {
  const settings = await getSettings();
  
  let resolveToken = settings?.internalProxyResolveToken;
  let reportToken = settings?.internalProxyReportToken;
  let needsUpdate = false;

  // Auto-generate if not exists
  if (!resolveToken) {
    resolveToken = generateProxyToken();
    needsUpdate = true;
  }

  if (!reportToken) {
    reportToken = generateProxyToken();
    needsUpdate = true;
  }

  // Save to database if generated
  if (needsUpdate) {
    await updateSettings({
      internalProxyResolveToken: resolveToken,
      internalProxyReportToken: reportToken,
    });
  }

  return {
    resolveToken,
    reportToken,
  };
}

/**
 * Regenerate internal proxy tokens
 */
export async function regenerateInternalProxyTokens() {
  const resolveToken = generateProxyToken();
  const reportToken = generateProxyToken();

  await updateSettings({
    internalProxyResolveToken: resolveToken,
    internalProxyReportToken: reportToken,
  });

  return {
    resolveToken,
    reportToken,
  };
}
