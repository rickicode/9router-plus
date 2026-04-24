import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { cookies } from "next/headers";
import { getClientIP } from "@/lib/security/ipValidator";
import { auditLog } from "@/lib/security/auditLog";

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "9router-default-secret-change-me"
);

// Rate limiter
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Cleanup expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of loginAttempts.entries()) {
    if (data.resetAt < now) {
      loginAttempts.delete(ip);
    }
  }
}, 5 * 60 * 1000);

function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  
  if (!record || record.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }
  
  if (record.count >= MAX_ATTEMPTS) {
    return { 
      allowed: false, 
      resetAt: record.resetAt,
      remainingMs: record.resetAt - now 
    };
  }
  
  record.count++;
  return { allowed: true };
}

function isTunnelRequest(request, settings) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  
  const getTunnelHost = (url) => {
    if (!url) return "";
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  };
  
  const tunnelHost = getTunnelHost(settings.tunnelUrl);
  const tailscaleHost = getTunnelHost(settings.tailscaleUrl);
  
  return (tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost);
}

export async function POST(request) {
  try {
    const settings = await getSettings();
    const clientIP = getClientIP(request, settings);

    // Check rate limit
    const rateLimit = checkRateLimit(clientIP);
    if (!rateLimit.allowed) {
      const retryAfterSeconds = Math.ceil(rateLimit.remainingMs / 1000);
      
      if (settings?.auditLogEnabled) {
        auditLog.log("rate_limit_exceeded", {
          ip: clientIP,
          attempts: MAX_ATTEMPTS,
          resetAt: new Date(rateLimit.resetAt).toISOString()
        });
      }
      
      return NextResponse.json(
        { 
          error: `Too many login attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`,
          retryAfter: retryAfterSeconds
        },
        { 
          status: 429,
          headers: { "Retry-After": retryAfterSeconds.toString() }
        }
      );
    }

    const { password } = await request.json();

    // Block login via tunnel/tailscale if dashboard access is disabled
    if (isTunnelRequest(request, settings) && settings.tunnelDashboardAccess !== true) {
      if (settings?.auditLogEnabled) {
        auditLog.log("login_attempt", {
          ip: clientIP,
          success: false,
          reason: "tunnel_access_disabled"
        });
      }
      return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 });
    }

    // Default password is '123456' if not set
    const storedHash = settings.password;

    let isValid = false;
    if (storedHash) {
      isValid = await bcrypt.compare(password, storedHash);
    } else {
      const initialPassword = process.env.INITIAL_PASSWORD || "123456";
      isValid = password === initialPassword;
    }

    if (isValid) {
      const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
      const forwardedProto = request.headers.get("x-forwarded-proto");
      const isHttpsRequest = forwardedProto === "https";
      const useSecureCookie = forceSecureCookie || isHttpsRequest;

      const token = await new SignJWT({ authenticated: true })
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("24h")
        .sign(SECRET);

      const cookieStore = await cookies();
      cookieStore.set("auth_token", token, {
        httpOnly: true,
        secure: useSecureCookie,
        sameSite: "lax",
        path: "/",
      });

      if (settings?.auditLogEnabled) {
        auditLog.log("login_attempt", {
          ip: clientIP,
          success: true
        });
      }

      return NextResponse.json({ success: true });
    }

    if (settings?.auditLogEnabled) {
      auditLog.log("login_attempt", {
        ip: clientIP,
        success: false,
        reason: "invalid_password"
      });
    }

    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
