// src/lib/security/ipValidator.js
export function getClientIP(request, settings = {}) {
  // Priority 1: Socket IP (most reliable)
  const socketIP = request?.socket?.remoteAddress;
  
  // Priority 2: X-Forwarded-For (only if trusted proxy enabled)
  if (settings.trustedProxyEnabled) {
    const xForwardedFor = request?.headers?.get?.("x-forwarded-for");
    if (xForwardedFor) {
      const firstIP = xForwardedFor.split(",")[0].trim();
      return normalizeIP(firstIP);
    }
  }
  
  // Priority 3: Socket IP (if not using proxy headers)
  if (socketIP) {
    return normalizeIP(socketIP);
  }
  
  // Priority 4: X-Real-IP (fallback)
  const xRealIP = request?.headers?.get?.("x-real-ip");
  if (xRealIP) {
    return normalizeIP(xRealIP);
  }
  
  return null;
}

export function normalizeIP(ip) {
  if (!ip) return null;
  
  // Remove IPv4-mapped IPv6 prefix (::ffff:127.0.0.1 → 127.0.0.1)
  if (ip.startsWith("::ffff:")) {
    return ip.substring(7);
  }
  
  return ip;
}

function ipToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  return parts.reduce((acc, part) => (acc << 8) + parseInt(part, 10), 0) >>> 0;
}

function cidrMatch(ip, cidr) {
  const [range, bits] = cidr.split("/");
  const mask = ~((1 << (32 - parseInt(bits, 10))) - 1);
  
  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(range);
  
  if (ipInt === null || rangeInt === null) return false;
  
  return (ipInt & mask) === (rangeInt & mask);
}

export function isWhitelistedIP(ip, whitelist) {
  if (!ip || !Array.isArray(whitelist)) return false;
  
  const normalizedIP = normalizeIP(ip);
  
  for (const entry of whitelist) {
    // Exact match
    if (entry === normalizedIP) {
      return true;
    }
    
    // CIDR match
    if (entry.includes("/")) {
      if (cidrMatch(normalizedIP, entry)) {
        return true;
      }
    }
  }
  
  return false;
}

export function isLocalRequest(request, settings) {
  const clientIP = getClientIP(request);
  if (!clientIP) return false;
  
  const whitelist = settings?.ipWhitelist || ["127.0.0.1", "::1", "172.17.0.0/16"];
  return isWhitelistedIP(clientIP, whitelist);
}
