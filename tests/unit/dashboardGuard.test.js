// tests/unit/dashboardGuard.test.js
import { describe, it, expect, vi } from "vitest";

// Mock dependencies
vi.mock("@/lib/security/ipValidator", () => ({
  isLocalRequest: vi.fn(),
  getClientIP: vi.fn()
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn()
}));

import { proxy } from "../../src/dashboardGuard.js";
import { isLocalRequest, getClientIP } from "@/lib/security/ipValidator";
import { getSettings } from "@/lib/localDb";

describe("Dashboard Guard - IP Validation", () => {
  it("allows localhost access to ALWAYS_PROTECTED paths", async () => {
    isLocalRequest.mockReturnValue(true);
    getSettings.mockResolvedValue({ requireLogin: true });

    const mockRequest = {
      nextUrl: { pathname: "/api/shutdown" },
      headers: { get: () => "localhost" },
      cookies: { get: () => null }
    };

    const response = await proxy(mockRequest);
    expect(response.status).not.toBe(401);
  });

  it("denies remote access to ALWAYS_PROTECTED paths", async () => {
    isLocalRequest.mockReturnValue(false);
    getSettings.mockResolvedValue({ requireLogin: true });

    const mockRequest = {
      nextUrl: { pathname: "/api/shutdown" },
      headers: { get: () => "example.com" },
      cookies: { get: () => null }
    };

    const response = await proxy(mockRequest);
    expect(response.status).toBe(401);
  });

  it("uses IP validator instead of Host header", async () => {
    getClientIP.mockReturnValue("192.168.1.100");
    isLocalRequest.mockReturnValue(false);
    getSettings.mockResolvedValue({ requireLogin: true });

    const mockRequest = {
      nextUrl: { pathname: "/api/settings" },
      headers: { get: (name) => name === "host" ? "localhost" : null },
      cookies: { get: () => null }
    };

    await proxy(mockRequest);
    
    // Verify IP validator was called, not Host header check
    expect(isLocalRequest).toHaveBeenCalled();
  });
});

vi.mock("@/lib/security/auditLog", () => ({
  auditLog: {
    log: vi.fn()
  }
}));

import { auditLog } from "@/lib/security/auditLog";

describe("Dashboard Guard - Audit Logging", () => {
  it("logs auth bypass attempts", async () => {
    isLocalRequest.mockReturnValue(false);
    getClientIP.mockReturnValue("192.168.1.100");
    getSettings.mockResolvedValue({ requireLogin: true, auditLogEnabled: true });

    const mockRequest = {
      nextUrl: { pathname: "/api/shutdown" },
      headers: { get: () => "example.com" },
      cookies: { get: () => null }
    };

    await proxy(mockRequest);
    
    expect(auditLog.log).toHaveBeenCalledWith(
      "auth_bypass_attempt",
      expect.objectContaining({
        ip: "192.168.1.100",
        path: "/api/shutdown",
        allowed: false
      })
    );
  });

  it("logs successful localhost bypass", async () => {
    isLocalRequest.mockReturnValue(true);
    getClientIP.mockReturnValue("127.0.0.1");
    getSettings.mockResolvedValue({ requireLogin: true, auditLogEnabled: true });

    const mockRequest = {
      nextUrl: { pathname: "/api/settings" },
      headers: { get: () => "localhost" },
      cookies: { get: () => null }
    };

    await proxy(mockRequest);
    
    expect(auditLog.log).toHaveBeenCalledWith(
      "auth_bypass_attempt",
      expect.objectContaining({
        ip: "127.0.0.1",
        path: "/api/settings",
        allowed: true,
        reason: "localhost_whitelist"
      })
    );
  });
});

describe("Dashboard Guard - Integration Tests", () => {
  it("end-to-end: localhost access allowed", async () => {
    isLocalRequest.mockReturnValue(true);
    getClientIP.mockReturnValue("127.0.0.1");
    getSettings.mockResolvedValue({ 
      requireLogin: true,
      auditLogEnabled: true,
      ipWhitelist: ["127.0.0.1"]
    });

    const mockRequest = {
      nextUrl: { pathname: "/dashboard" },
      url: "http://localhost:20128/dashboard",
      headers: { get: () => "localhost" },
      cookies: { get: () => null }
    };

    const response = await proxy(mockRequest);
    expect(response.status).not.toBe(401);
  });

  it("end-to-end: remote access denied without JWT", async () => {
    isLocalRequest.mockReturnValue(false);
    getClientIP.mockReturnValue("203.0.113.5");
    getSettings.mockResolvedValue({ 
      requireLogin: true,
      auditLogEnabled: true
    });

    const mockRequest = {
      nextUrl: { pathname: "/dashboard" },
      url: "http://example.com/dashboard",
      headers: { get: () => "example.com" },
      cookies: { get: () => null }
    };

    const response = await proxy(mockRequest);
    expect(response.status).toBe(307); // NextResponse.redirect uses 307
  });

  it("end-to-end: tunnel access blocked when disabled", async () => {
    isLocalRequest.mockReturnValue(false);
    getClientIP.mockReturnValue("203.0.113.5");
    getSettings.mockResolvedValue({ 
      requireLogin: true,
      tunnelDashboardAccess: false,
      tunnelUrl: "https://tunnel.example.com",
      auditLogEnabled: true
    });

    const mockRequest = {
      nextUrl: { pathname: "/dashboard" },
      url: "https://tunnel.example.com/dashboard",
      headers: { get: (name) => name === "host" ? "tunnel.example.com" : null },
      cookies: { get: () => null }
    };

    const response = await proxy(mockRequest);
    expect(response.status).toBe(307); // NextResponse.redirect uses 307
    expect(auditLog.log).toHaveBeenCalledWith(
      "tunnel_access_attempt",
      expect.objectContaining({
        allowed: false
      })
    );
  });
});
