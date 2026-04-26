import crypto from "crypto";
import { getSettings, updateSettings } from "@/lib/localDb";

// Cache the resolved tokens in process memory. The internal proxy resolve
// endpoint runs on every routed request, so reading + cloning the entire DB
// (via getSettings → getDb) on every call is hot-path overhead the router
// can avoid. Tokens only change when the user explicitly regenerates them
// via regenerateInternalProxyTokens(), which invalidates the cache.
const TOKEN_CACHE_TTL_MS = 30 * 1000;
let cachedTokens = null;
let cachedTokensExpiresAt = 0;

function setCachedTokens(tokens) {
  cachedTokens = tokens;
  cachedTokensExpiresAt = Date.now() + TOKEN_CACHE_TTL_MS;
}

function invalidateTokenCache() {
  cachedTokens = null;
  cachedTokensExpiresAt = 0;
}

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
  if (cachedTokens && Date.now() < cachedTokensExpiresAt) {
    return cachedTokens;
  }

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

  const tokens = { resolveToken, reportToken };
  setCachedTokens(tokens);
  return tokens;
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

  const tokens = { resolveToken, reportToken };
  setCachedTokens(tokens);
  return tokens;
}

/**
 * Drop the in-memory token cache. Use after operations that may have changed
 * settings out-of-band (e.g. database import).
 */
export function invalidateInternalProxyTokenCache() {
  invalidateTokenCache();
}
