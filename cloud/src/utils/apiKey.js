/**
 * API Key utilities for Worker
 * Supports both formats:
 * - Scoped: sk-{runtimeScope}-{keyId}-{crc8}
 * - Legacy: sk-{random8}
 */

const API_KEY_SECRET = "endpoint-proxy-api-key-secret";

/**
 * Generate CRC (8-char HMAC) using Web Crypto API
 */
async function generateCrc(runtimeScope, keyId) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(API_KEY_SECRET);
  const data = encoder.encode(runtimeScope + keyId);
  
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  
  const signature = await crypto.subtle.sign("HMAC", key, data);
  const hashArray = Array.from(new Uint8Array(signature));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  
  return hashHex.slice(0, 8);
}

/**
 * Parse API key and extract runtimeScope + keyId.
 * @param {string} apiKey
 * @returns {Promise<{ runtimeScope: string | null, keyId: string, isNewFormat: boolean } | null>}
 */
export async function parseApiKey(apiKey) {
  if (!apiKey || !apiKey.startsWith("sk-")) return null;

  const parts = apiKey.split("-");
  
  // Scoped format: sk-{runtimeScope}-{keyId}-{crc8} = 4 parts
  if (parts.length === 4) {
    const [, runtimeScope, keyId, crc] = parts;
    
    // Verify CRC
    const expectedCrc = await generateCrc(runtimeScope, keyId);
    if (crc !== expectedCrc) return null;
    
    return { runtimeScope, keyId, isNewFormat: true };
  }
  
  // Legacy format: sk-{random8} = 2 parts
  if (parts.length === 2) {
    return { runtimeScope: null, keyId: parts[1], isNewFormat: false };
  }
  
  return null;
}

/**
 * Extract Bearer token from Authorization header
 * @param {Request} request
 * @returns {string | null}
 */
export function extractBearerToken(request) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

