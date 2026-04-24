// tests/unit/ipValidator.test.js
import { describe, it, expect } from "vitest";
import { getClientIP, isWhitelistedIP, isLocalRequest, normalizeIP } from "../../src/lib/security/ipValidator.js";

describe("IP Validator - IPv4 Localhost", () => {
  it("detects IPv4 localhost (127.0.0.1)", () => {
    const ip = "127.0.0.1";
    const whitelist = ["127.0.0.1", "::1"];
    expect(isWhitelistedIP(ip, whitelist)).toBe(true);
  });

  it("rejects non-whitelisted IPv4", () => {
    const ip = "192.168.1.100";
    const whitelist = ["127.0.0.1", "::1"];
    expect(isWhitelistedIP(ip, whitelist)).toBe(false);
  });

  it("extracts IP from mock request", () => {
    const mockRequest = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { get: () => null }
    };
    expect(getClientIP(mockRequest)).toBe("127.0.0.1");
  });
});

describe("IP Validator - IPv6 and CIDR", () => {
  it("detects IPv6 localhost (::1)", () => {
    const ip = "::1";
    const whitelist = ["127.0.0.1", "::1"];
    expect(isWhitelistedIP(ip, whitelist)).toBe(true);
  });

  it("matches IPv4 CIDR range (172.17.0.0/16)", () => {
    const ip = "172.17.0.5";
    const whitelist = ["172.17.0.0/16"];
    expect(isWhitelistedIP(ip, whitelist)).toBe(true);
  });

  it("rejects IPv4 outside CIDR range", () => {
    const ip = "172.18.0.5";
    const whitelist = ["172.17.0.0/16"];
    expect(isWhitelistedIP(ip, whitelist)).toBe(false);
  });

  it("normalizes IPv4-mapped IPv6", () => {
    const ip = "::ffff:127.0.0.1";
    expect(normalizeIP(ip)).toBe("127.0.0.1");
  });
});

describe("IP Validator - Trusted Proxy Headers", () => {
  it("uses X-Forwarded-For when trustedProxyEnabled=true", () => {
    const mockRequest = {
      socket: { remoteAddress: "10.0.0.1" },
      headers: { 
        get: (name) => name === "x-forwarded-for" ? "203.0.113.5, 10.0.0.1" : null 
      }
    };
    const settings = { trustedProxyEnabled: true };
    expect(getClientIP(mockRequest, settings)).toBe("203.0.113.5");
  });

  it("ignores X-Forwarded-For when trustedProxyEnabled=false", () => {
    const mockRequest = {
      socket: { remoteAddress: "10.0.0.1" },
      headers: { 
        get: (name) => name === "x-forwarded-for" ? "203.0.113.5" : null 
      }
    };
    const settings = { trustedProxyEnabled: false };
    expect(getClientIP(mockRequest, settings)).toBe("10.0.0.1");
  });

  it("falls back to X-Real-IP if X-Forwarded-For missing", () => {
    const mockRequest = {
      socket: null,
      headers: { 
        get: (name) => name === "x-real-ip" ? "203.0.113.10" : null 
      }
    };
    expect(getClientIP(mockRequest)).toBe("203.0.113.10");
  });
});
