import { NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { getSettings } from "@/lib/localDb";
import { isLocalRequest, getClientIP } from "@/lib/security/ipValidator";
import { auditLog } from "@/lib/security/auditLog";

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "9router-default-secret-change-me"
);

// Always require JWT token regardless of requireLogin setting
const ALWAYS_PROTECTED = [
  "/api/shutdown",
  "/api/settings/database",
];

// Require auth, but allow through if requireLogin is disabled
const PROTECTED_API_PATHS = [
  "/api/settings",
  "/api/keys",
  "/api/providers/client",
  "/api/provider-nodes/validate",
  "/api/opencode",
];

async function hasValidToken(request) {
  const token = request.cookies.get("auth_token")?.value;
  if (!token) return false;
  try {
    await jwtVerify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}

// Read settings directly from DB to avoid self-fetch deadlock in proxy
async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

async function isAuthenticated(request) {
  if (await hasValidToken(request)) return true;
  const settings = await loadSettings();
  if (settings && settings.requireLogin === false) return true;
  return false;
}

function getTunnelHostname(tunnelUrl) {
  if (!tunnelUrl || typeof tunnelUrl !== "string") return "";
  try {
    const url = new URL(tunnelUrl);
    // Only allow http/https protocols
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.hostname.toLowerCase();
  } catch {
    return ""; // Invalid URL format
  }
}

export async function proxy(request) {
  const { pathname } = request.nextUrl;
  const settings = await loadSettings();
  const clientIP = getClientIP(request, settings);

  // Always protected - allow localhost/whitelist or valid JWT only
  if (ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
    const isLocal = isLocalRequest(request, settings);
    const hasToken = await hasValidToken(request);
    
    if (settings?.auditLogEnabled) {
      auditLog.log("auth_bypass_attempt", {
        ip: clientIP,
        path: pathname,
        allowed: isLocal || hasToken,
        reason: isLocal ? "localhost_whitelist" : hasToken ? "valid_jwt" : "denied"
      });
    }
    
    if (isLocal || hasToken) {
      return NextResponse.next();
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Protect sensitive API endpoints
  if (PROTECTED_API_PATHS.some((p) => pathname.startsWith(p))) {
    if (pathname === "/api/settings/require-login") return NextResponse.next();
    
    const isLocal = isLocalRequest(request, settings);
    const isAuth = await isAuthenticated(request);
    
    if (settings?.auditLogEnabled) {
      auditLog.log("auth_bypass_attempt", {
        ip: clientIP,
        path: pathname,
        allowed: isLocal || isAuth,
        reason: isLocal ? "localhost_whitelist" : isAuth ? "authenticated" : "denied"
      });
    }
    
    if (isLocal || isAuth) {
      return NextResponse.next();
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Protect all dashboard routes
  if (pathname.startsWith("/dashboard")) {
    let requireLogin = true;
    let tunnelDashboardAccess = true;

    try {
      if (settings) {
        requireLogin = settings.requireLogin !== false;
        tunnelDashboardAccess = settings.tunnelDashboardAccess === true;

        // Block tunnel/tailscale access if disabled
        if (!tunnelDashboardAccess) {
          const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
          const tunnelHost = getTunnelHostname(settings.tunnelUrl);
          const tailscaleHost = getTunnelHostname(settings.tailscaleUrl);
          
          if ((tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost)) {
            if (settings?.auditLogEnabled) {
              auditLog.log("tunnel_access_attempt", {
                ip: clientIP,
                host,
                allowed: false,
                tunnelUrl: settings.tunnelUrl || settings.tailscaleUrl
              });
            }
            return NextResponse.redirect(new URL("/login", request.url));
          }
        }
      }
    } catch {
      // On error, keep defaults
    }

    // If login not required, allow through
    if (!requireLogin) return NextResponse.next();

    // Verify JWT token
    const token = request.cookies.get("auth_token")?.value;
    if (token) {
      try {
        await jwtVerify(token, SECRET);
        return NextResponse.next();
      } catch {
        if (settings?.auditLogEnabled) {
          auditLog.log("jwt_validation_failed", {
            ip: clientIP,
            path: pathname,
            error: "invalid_or_expired"
          });
        }
        return NextResponse.redirect(new URL("/login", request.url));
      }
    }

    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Redirect / to /dashboard
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}
