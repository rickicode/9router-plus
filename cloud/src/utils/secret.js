/**
 * Shared-secret utilities for worker admin endpoints.
 *
 * The cloud worker now trusts a single shared secret injected through env.
 * 9Router sends that secret in the `X-Cloud-Secret` header (preferred) or in
 * a `?token=` query parameter for the server-rendered dashboard page.
 */

/**
 * Extract a presented secret from a request.
 * @param {Request} request
 * @returns {string | null}
 */
export function extractSecret(request) {
  const headerSecret = request.headers.get("X-Cloud-Secret");
  if (headerSecret) return headerSecret;

  const url = new URL(request.url);
  const tokenParam = url.searchParams.get("token");
  if (tokenParam) return tokenParam;

  return null;
}

/**
 * Constant-time string comparison.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function getConfiguredSharedSecret(env) {
  const secret = typeof env?.CLOUD_SHARED_SECRET === "string"
    ? env.CLOUD_SHARED_SECRET.trim()
    : typeof env?.WORKER_SHARED_SECRET === "string"
      ? env.WORKER_SHARED_SECRET.trim()
      : "";
  return secret || null;
}

export function isWorkerSharedSecretValid(request, env) {
  const presented = extractSecret(request);
  const configured = getConfiguredSharedSecret(env);
  if (!presented || !configured) return false;
  return constantTimeEqual(presented, configured);
}

/**
 * Generate a new 32-byte hex secret using Web Crypto.
 * @returns {string}
 */
export function generateSecret() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
