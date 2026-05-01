import { beforeEach, describe, expect, it, vi } from "vitest";

const getProviderConnections = vi.fn();
const getModelAliases = vi.fn();
const getCombos = vi.fn();
const getApiKeys = vi.fn();
const getSettings = vi.fn();
const exportDb = vi.fn();

vi.mock("@/lib/localDb", () => ({
  DB_BACKUP_FORMAT: "9router-db-v1",
  DB_BACKUP_SCHEMA_VERSION: 1,
  exportDb,
  getProviderConnections,
  getModelAliases,
  getCombos,
  getApiKeys,
  getSettings,
}));

describe("r2RuntimeArtifacts", () => {
  beforeEach(() => {
    vi.resetModules();
    exportDb.mockReset();
    getProviderConnections.mockReset();
    getModelAliases.mockReset();
    getCombos.mockReset();
    getApiKeys.mockReset();
    getSettings.mockReset();
  });

  it("builds backup artifact close to exportDb shape and runtime artifact from active eligible providers", async () => {
    const exportedSnapshot = {
      format: "9router-db-v1",
      schemaVersion: 1,
      providerConnections: [
        {
          id: "conn-eligible",
          provider: "openai",
          authType: "apikey",
          name: "Primary",
          apiKey: "sk-live",
          isActive: true,
          routingStatus: "blocked",
          createdAt: "2026-04-26T00:00:00.000Z",
          updatedAt: "2026-04-26T00:00:00.000Z",
        },
        {
          id: "conn-ineligible",
          provider: "anthropic",
          authType: "oauth",
          name: "Blocked",
          accessToken: "token-1",
          isActive: true,
          routingStatus: "blocked",
        },
        {
          id: "conn-inactive",
          provider: "gemini",
          authType: "apikey",
          name: "Disabled",
          apiKey: "gem-key",
          isActive: false,
          routingStatus: "eligible",
        },
      ],
      providerNodes: [{ id: "node-1", type: "provider", name: "Node 1" }],
      proxyPools: [{ id: "pool-1", name: "Pool 1", isActive: true }],
      modelAliases: { smart: "openai/gpt-4.1" },
      customModels: [{ providerAlias: "openai", id: "gpt-custom", type: "llm", name: "GPT Custom" }],
      mitmAlias: { codex: { default: "smart" } },
      combos: [{ id: "combo-1", name: "Fallback", models: ["smart"] }],
      apiKeys: [
        { id: "key-1", key: "worker-key", name: "worker", isActive: true },
        { id: "key-disabled", key: "disabled-key", name: "disabled", isActive: false },
      ],
      settings: {
        cloudEnabled: true,
        providerStrategies: { smart: "round-robin" },
        roundRobin: true,
        sticky: false,
        stickyDuration: 120,
        morph: {
          baseUrl: "https://api.morphllm.com",
          apiKeys: [
            { email: "active@example.com", key: "mk-active", status: "active", isExhausted: false },
            { email: "inactive@example.com", key: "mk-inactive", status: "inactive", isExhausted: false },
            { email: "exhausted@example.com", key: "mk-exhausted", status: "active", isExhausted: true },
          ],
          roundRobinEnabled: true,
        },
        r2Config: {
          accessKeyId: "r2-key",
          secretAccessKey: "r2-secret",
        },
        cloudUrls: [{ url: "https://worker.example.com", secret: "worker-secret" }],
        r2RuntimePublicBaseUrl: "https://runtime.example.com",
      },
      pricing: { openai: { "gpt-4.1": { input: 1, output: 2 } } },
    };

    exportDb.mockResolvedValue(structuredClone(exportedSnapshot));
    getProviderConnections.mockResolvedValue([
      {
        id: "conn-eligible",
        provider: "openai",
        authType: "apikey",
        name: "Primary",
        apiKey: "sk-live",
        isActive: true,
        routingStatus: "eligible",
        createdAt: "2026-04-26T00:00:00.000Z",
        updatedAt: "2026-04-26T00:00:00.000Z",
      },
      { id: "conn-ineligible", provider: "anthropic", isActive: true, routingStatus: "blocked" },
      { id: "conn-inactive", provider: "gemini", isActive: false, routingStatus: "eligible" },
    ]);
    getModelAliases.mockResolvedValue({ getter: "should/not/use" });
    getCombos.mockResolvedValue([{ id: "getter-combo", name: "Getter", models: ["getter"] }]);
    getApiKeys.mockResolvedValue([{ id: "getter-key", key: "getter-key", isActive: true }]);
    getSettings.mockResolvedValue({ roundRobin: false });

    const {
      buildBackupArtifact,
      buildRuntimeArtifact,
      buildEligibleRuntimeArtifact,
      buildR2ArtifactsFromState,
      buildFullCredentialsArtifact,
    } = await import("@/lib/r2RuntimeArtifacts.js");

    const backup = await buildBackupArtifact();
    expect(exportDb).toHaveBeenCalledTimes(1);
    expect(backup).toEqual(exportedSnapshot);
    expect(backup.providerNodes).toEqual([{ id: "node-1", type: "provider", name: "Node 1" }]);
    expect(backup.proxyPools).toEqual([{ id: "pool-1", name: "Pool 1", isActive: true }]);
    expect(backup.customModels).toEqual([
      { providerAlias: "openai", id: "gpt-custom", type: "llm", name: "GPT Custom" },
    ]);
    expect(backup.mitmAlias).toEqual({ codex: { default: "smart" } });
    expect(backup.pricing).toEqual({ openai: { "gpt-4.1": { input: 1, output: 2 } } });

    const runtime = await buildRuntimeArtifact();
    expect(runtime).toMatchObject({
      providers: {
        "conn-eligible": expect.objectContaining({
          id: "conn-eligible",
          provider: "openai",
          routingStatus: "eligible",
          isActive: true,
        }),
      },
      modelAliases: { smart: "openai/gpt-4.1" },
      combos: [{ id: "combo-1", name: "Fallback", models: ["smart"] }],
      apiKeys: [{ id: "key-1", key: "worker-key", isActive: true }],
      settings: {
        providerStrategies: { smart: "round-robin" },
        roundRobin: true,
        sticky: false,
        stickyDuration: 120,
        morph: {
          baseUrl: "https://api.morphllm.com",
          apiKeys: [
            { email: "active@example.com", key: "mk-active", status: "active", isExhausted: false },
          ],
          roundRobinEnabled: true,
        },
      },
    });
    expect(runtime.providers["conn-ineligible"]).toBeUndefined();
    expect(runtime.providers["conn-inactive"]).toBeUndefined();

    const eligible = await buildEligibleRuntimeArtifact();
    expect(eligible).toEqual({
      generatedAt: expect.any(String),
      providers: {
        "conn-eligible": expect.objectContaining({
          id: "conn-eligible",
          provider: "openai",
          routingStatus: "eligible",
          isActive: true,
        }),
      },
    });

    const fullCredentials = await buildFullCredentialsArtifact();
    expect(fullCredentials.providers).toEqual({
      "conn-eligible": expect.objectContaining({
        id: "conn-eligible",
        provider: "openai",
        routingStatus: "eligible",
      }),
    });
    expect(fullCredentials.apiKeys).toEqual([
      { id: "key-1", key: "worker-key", name: "worker", isActive: true },
    ]);

    const artifacts = await buildR2ArtifactsFromState();
    expect(artifacts.backup).toEqual(exportedSnapshot);
    expect(artifacts.runtime).toMatchObject({
      providers: {
        "conn-eligible": expect.objectContaining({
          id: "conn-eligible",
          provider: "openai",
          routingStatus: "eligible",
          isActive: true,
        }),
      },
      modelAliases: { smart: "openai/gpt-4.1" },
      combos: [{ id: "combo-1", name: "Fallback", models: ["smart"] }],
      apiKeys: [{ id: "key-1", key: "worker-key", name: "worker", isActive: true }],
      settings: {
        providerStrategies: { smart: "round-robin" },
        roundRobin: true,
        sticky: false,
        stickyDuration: 120,
        morph: {
          baseUrl: "https://api.morphllm.com",
          apiKeys: [{ id: undefined, email: "active@example.com", key: "mk-active", status: "active", isExhausted: false }],
          roundRobinEnabled: true,
        },
      },
    });
    expect(artifacts.credentials.providers).toEqual({
      "conn-eligible": expect.objectContaining({
        id: "conn-eligible",
        provider: "openai",
        routingStatus: "eligible",
      }),
    });
    expect(artifacts.credentials.apiKeys).toEqual([
      { id: "key-1", key: "worker-key", name: "worker", isActive: true },
    ]);
    expect(artifacts.eligible).toEqual({
      generatedAt: expect.any(String),
      providers: {
        "conn-eligible": expect.objectContaining({
          id: "conn-eligible",
          provider: "openai",
          routingStatus: "eligible",
          isActive: true,
        }),
      },
    });
    expect(artifacts.runtime.settings.r2Config).toBeUndefined();
    expect(artifacts.runtime.settings.cloudUrls).toBeUndefined();
    expect(artifacts.runtime.settings.r2RuntimePublicBaseUrl).toBeUndefined();
    expect(artifacts.runtime.providers["conn-ineligible"]).toBeUndefined();
    expect(artifacts.runtime.providers["conn-inactive"]).toBeUndefined();
    expect(artifacts.runtime.generatedAt).toEqual(expect.any(String));
  });

  it("buildR2ArtifactsFromState keeps backup data from exportDb while runtime artifacts use merged eligible connections", async () => {
    const exportedSnapshot = {
      format: "9router-db-v1",
      schemaVersion: 1,
      providerConnections: [
        { id: "backup-only", provider: "stale", isActive: true, routingStatus: "blocked" },
        { id: "disabled", provider: "stale", isActive: false, routingStatus: "eligible" },
      ],
      providerNodes: [{ id: "stale-node" }],
      proxyPools: [],
      modelAliases: { stale: "provider/model" },
      customModels: [],
      mitmAlias: {},
      combos: [],
      apiKeys: [],
      settings: { roundRobin: false },
      pricing: {},
    };
    exportDb.mockResolvedValue(structuredClone(exportedSnapshot));
    getProviderConnections.mockResolvedValue([
      { id: "conn-1", provider: "openai", isActive: true, routingStatus: "eligible" },
    ]);
    getModelAliases.mockResolvedValue({ live: "openai/gpt-4.1" });
    getCombos.mockResolvedValue([{ id: "combo-live", name: "Live", models: ["live"] }]);
    getApiKeys.mockResolvedValue([{ id: "key-live", key: "live-key", isActive: true }]);
    getSettings.mockResolvedValue({ roundRobin: true });

    const { buildR2ArtifactsFromState } = await import("@/lib/r2RuntimeArtifacts.js");

    const artifacts = await buildR2ArtifactsFromState();

    expect(artifacts.backup).toEqual(exportedSnapshot);
    expect(artifacts.runtime.providers).toEqual({
      "conn-1": expect.objectContaining({
        id: "conn-1",
        provider: "openai",
        isActive: true,
        routingStatus: "eligible",
      }),
    });
    expect(artifacts.credentials.providers).toEqual({
      "conn-1": expect.objectContaining({
        id: "conn-1",
        provider: "openai",
        routingStatus: "eligible",
      }),
    });
    expect(artifacts.runtime.modelAliases).toEqual({ stale: "provider/model" });
    expect(artifacts.runtime.combos).toEqual([]);
    expect(artifacts.runtime.apiKeys).toEqual([]);
    expect(artifacts.runtime.settings).toEqual({ roundRobin: false });
  });

  it("buildRuntimeArtifact clones output and tolerates malformed export snapshot data", async () => {
    const sourceSnapshot = {
      format: "9router-db-v1",
      schemaVersion: 1,
      providerConnections: [
        { id: "conn-eligible", provider: "openai", isActive: true, routingStatus: "eligible", meta: { lane: 1 } },
        { provider: "missing-id", isActive: true, routingStatus: "eligible" },
        { id: "conn-no-status", provider: "anthropic", isActive: true },
      ],
      modelAliases: { smart: "openai/gpt-4.1" },
      combos: [{ id: "combo-1", name: "Fallback", models: ["smart"] }],
      apiKeys: [{ id: "key-1", key: "worker-key", isActive: true }],
      settings: { providerStrategies: { smart: "round-robin" } },
    };

    exportDb.mockImplementation(async () => structuredClone(sourceSnapshot));
    getProviderConnections.mockResolvedValue(structuredClone(sourceSnapshot.providerConnections));

    const { buildRuntimeArtifact } = await import("@/lib/r2RuntimeArtifacts.js");

    const runtime = await buildRuntimeArtifact();
    runtime.providers["conn-eligible"].meta.lane = 99;
    runtime.modelAliases.smart = "mutated/model";
    runtime.combos[0].models.push("mutated");
    runtime.apiKeys[0].key = "changed";
    runtime.settings.providerStrategies.smart = "sticky";

    expect(Object.keys(runtime.providers)).toEqual(["conn-eligible"]);
    expect(sourceSnapshot.providerConnections[0].meta.lane).toBe(1);
    expect(sourceSnapshot.modelAliases.smart).toBe("openai/gpt-4.1");
    expect(sourceSnapshot.combos[0].models).toEqual(["smart"]);
    expect(sourceSnapshot.apiKeys[0].key).toBe("worker-key");
    expect(sourceSnapshot.settings.providerStrategies.smart).toBe("round-robin");
  });

  it("honors provided malformed snapshots without falling back to exportDb", async () => {
    const providedSnapshot = {
      format: "9router-db-v1",
      schemaVersion: 1,
      providerConnections: "not-an-array",
      providerNodes: [{ id: "node-direct" }],
      modelAliases: { direct: "provider/model" },
      combos: [{ id: "combo-direct", models: ["direct"] }],
      apiKeys: [{ id: "key-direct", key: "direct-key" }],
      settings: { roundRobin: true },
    };

    exportDb.mockResolvedValue({
      format: "should-not-use",
      schemaVersion: 99,
      providerConnections: [{ id: "fallback", isActive: true, routingStatus: "eligible" }],
    });
    getProviderConnections.mockResolvedValue([]);

    const {
      buildBackupArtifact,
      buildRuntimeArtifact,
      buildR2ArtifactsFromState,
    } = await import("@/lib/r2RuntimeArtifacts.js");

    const backup = await buildBackupArtifact(providedSnapshot);
    const runtime = await buildRuntimeArtifact(providedSnapshot, { generatedAt: "2026-04-27T00:00:00.000Z" });

    expect(backup).toEqual(providedSnapshot);
    expect(runtime).toEqual({
      generatedAt: "2026-04-27T00:00:00.000Z",
      providers: {},
      modelAliases: { direct: "provider/model" },
      combos: [{ id: "combo-direct", models: ["direct"] }],
      apiKeys: [{ id: "key-direct", key: "direct-key" }],
      settings: { roundRobin: true },
    });
    expect(exportDb).not.toHaveBeenCalled();

    exportDb.mockReset();
    const malformedExportSnapshot = {
      format: "9router-db-v1",
      schemaVersion: 1,
      providerConnections: "still-not-an-array",
      providerNodes: [{ id: "node-export" }],
      modelAliases: { exported: "provider/model" },
      combos: [{ id: "combo-export", models: ["exported"] }],
      apiKeys: [{ id: "key-export", key: "export-key" }],
      settings: { sticky: true },
    };
    exportDb.mockResolvedValue(structuredClone(malformedExportSnapshot));
    getProviderConnections.mockResolvedValue([]);

    const artifacts = await buildR2ArtifactsFromState();

    expect(artifacts.backup).toEqual(malformedExportSnapshot);
    expect(artifacts.runtime).toEqual({
      generatedAt: expect.any(String),
      providers: {},
      modelAliases: { exported: "provider/model" },
      combos: [{ id: "combo-export", models: ["exported"] }],
      apiKeys: [{ id: "key-export", key: "export-key" }],
      settings: { sticky: true },
    });
    expect(exportDb).toHaveBeenCalledTimes(1);
  });

  it("treats plain generatedAt objects as options rather than artifact snapshots", async () => {
    exportDb.mockResolvedValue({
      format: "9router-db-v1",
      schemaVersion: 1,
      providerConnections: [
        { id: "conn-opt", provider: "openai", isActive: true, routingStatus: "eligible" },
      ],
      modelAliases: { opt: "openai/gpt-4.1" },
      combos: [],
      apiKeys: [],
      settings: { roundRobin: true },
    });
    getProviderConnections.mockResolvedValue([
      { id: "conn-opt", provider: "openai", isActive: true, routingStatus: "eligible" },
    ]);

    const { buildRuntimeArtifact } = await import("@/lib/r2RuntimeArtifacts.js");

    const runtime = await buildRuntimeArtifact({ generatedAt: "2026-04-28T00:00:00.000Z" });

    expect(runtime).toEqual({
      generatedAt: "2026-04-28T00:00:00.000Z",
      providers: {
        "conn-opt": expect.objectContaining({
          id: "conn-opt",
          provider: "openai",
          isActive: true,
          routingStatus: "eligible",
        }),
      },
      modelAliases: { opt: "openai/gpt-4.1" },
      combos: [],
      apiKeys: [],
      settings: { roundRobin: true },
    });
    expect(exportDb).toHaveBeenCalledTimes(1);
  });

  it("buildFullCredentialsArtifact uses the provided snapshot instead of live provider connections", async () => {
    const snapshot = {
      format: "9router-db-v1",
      schemaVersion: 1,
      providerConnections: [
        { id: "snapshot-conn", provider: "openai", apiKey: "sk-snapshot", isActive: true, routingStatus: "eligible" },
      ],
      modelAliases: {},
      combos: [],
      apiKeys: [
        { id: "key-snapshot", key: "snapshot-worker-key", isActive: true },
      ],
      settings: {},
    };

    getProviderConnections.mockResolvedValue([
      { id: "live-conn", provider: "codex", accessToken: "live-token", isActive: true, routingStatus: "eligible" },
    ]);

    const { buildFullCredentialsArtifact } = await import("@/lib/r2RuntimeArtifacts.js");
    const artifact = await buildFullCredentialsArtifact(snapshot);

    expect(artifact.providers).toEqual({
      "snapshot-conn": expect.objectContaining({
        id: "snapshot-conn",
        provider: "openai",
        apiKey: "sk-snapshot",
      }),
    });
    expect(artifact.providers["live-conn"]).toBeUndefined();
    expect(artifact.apiKeys).toEqual([
      { id: "key-snapshot", key: "snapshot-worker-key", isActive: true },
    ]);
  });
});
