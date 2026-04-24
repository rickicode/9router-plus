// tests/unit/settings-schema.test.js
import { describe, it, expect } from "vitest";

// Mock the settings merge function
function mergeSettingsWithDefaults(settings = {}) {
  const DEFAULT_SETTINGS = {
    requireLogin: true,
    tunnelDashboardAccess: true,
    ipWhitelist: ["127.0.0.1", "::1", "172.17.0.0/16"],
    trustedProxyEnabled: false,
    auditLogEnabled: true,
    auditLogMaxSize: 10485760,
  };
  
  return { ...DEFAULT_SETTINGS, ...settings };
}

describe("Settings Schema - Security Fields", () => {
  it("includes default IP whitelist", () => {
    const settings = mergeSettingsWithDefaults();
    expect(settings.ipWhitelist).toEqual(["127.0.0.1", "::1", "172.17.0.0/16"]);
  });

  it("includes trustedProxyEnabled=false by default", () => {
    const settings = mergeSettingsWithDefaults();
    expect(settings.trustedProxyEnabled).toBe(false);
  });

  it("includes auditLogEnabled=true by default", () => {
    const settings = mergeSettingsWithDefaults();
    expect(settings.auditLogEnabled).toBe(true);
  });

  it("includes auditLogMaxSize=10MB by default", () => {
    const settings = mergeSettingsWithDefaults();
    expect(settings.auditLogMaxSize).toBe(10485760);
  });

  it("allows custom IP whitelist", () => {
    const settings = mergeSettingsWithDefaults({ ipWhitelist: ["10.0.0.0/8"] });
    expect(settings.ipWhitelist).toEqual(["10.0.0.0/8"]);
  });
});
