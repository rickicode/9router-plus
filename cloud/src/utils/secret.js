/**
 * Shared-secret utilities for worker admin endpoints.
 *
 * The cloud worker is identified per-machine. Each machineId stores a 32-byte
 * hex shared secret in `data.meta.secret`. The web app proves ownership by
 * presenting the secret in the `X-Cloud-Secret` header (preferred) or in a
 * `?token=` query parameter (only used by the human-facing status dashboard).
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

/**
 * Validate that a presented secret matches the secret stored for a machine.
 *
 * @param {string | null} presented - secret extracted from the request
 * @param {Object | null} data - machine data loaded from D1, may be null
 * @returns {boolean}
 */
export function isSecretValid(presented, data) {
  if (!presented) return false;
  const stored = data?.meta?.secret;
  if (!stored) return false;
  return constantTimeEqual(stored, presented);
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
