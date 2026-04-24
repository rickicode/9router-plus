import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs = [];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createTempDataDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "9router-cloud-usage-poller-"));
  tempDirs.push(dir);
  return dir;
}

async function loadModulesWithTempDataDir() {
  const dataDir = await createTempDataDir();
  process.env.DATA_DIR = dataDir;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  vi.resetModules();

  const localDb = await import("../../src/lib/localDb.js");
  const cloudUsagePollerModule = await import("../../src/shared/services/cloudUsagePoller.js");

  return { dataDir, localDb, cloudUsagePollerModule };
}

afterEach(async () => {
  delete process.env.DATA_DIR;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  vi.unstubAllGlobals();
  vi.resetModules();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async () => "machine-race-test"),
}));

vi.mock("@/lib/cloudUrlResolver", () => ({
  getCloudUrl: vi.fn(async () => "https://cloud.example.test"),
}));

describe("CloudUsagePoller concurrent providerSpecificData updates", () => {
  it("preserves concurrent providerSpecificData writes while storing cloud usage", async () => {
    const { localDb, cloudUsagePollerModule } = await loadModulesWithTempDataDir();

    const created = await localDb.createProviderConnection({
      provider: "codex",
      authType: "apikey",
      name: "Race test",
      apiKey: "secret",
      providerSpecificData: {
        sessionId: "session-1",
      },
    });

    const firstMutatorEntered = deferred();
    const releaseFirstMutator = deferred();
    const originalAtomicUpdate = localDb.atomicUpdateProviderConnection;
    const atomicSpy = vi.spyOn(localDb, "atomicUpdateProviderConnection");

    atomicSpy.mockImplementation(async (id, mutator) => {
      if (id !== created.id) {
        return await originalAtomicUpdate(id, mutator);
      }

      return await originalAtomicUpdate(id, async (current) => {
        firstMutatorEntered.resolve();
        await releaseFirstMutator.promise;
        return await mutator(current);
      });
    });

    const usagePayload = {
      usage: {
        [created.id]: {
          used: 42,
          limit: 100,
        },
      },
    };

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => usagePayload,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const poller = new cloudUsagePollerModule.CloudUsagePoller("machine-race-test", 3000);
    const pollPromise = poller.poll();

    await firstMutatorEntered.promise;

    const concurrentUpdatePromise = localDb.atomicUpdateProviderConnection(created.id, async (current) => ({
      providerSpecificData: {
        ...(current.providerSpecificData || {}),
        connectionProxyEnabled: true,
      },
    }));

    releaseFirstMutator.resolve();

    await Promise.all([pollPromise, concurrentUpdatePromise]);

    const updated = await localDb.getProviderConnectionById(created.id);
    expect(updated.providerSpecificData).toEqual({
      sessionId: "session-1",
      connectionProxyEnabled: true,
      cloudUsage: {
        used: 42,
        limit: 100,
      },
    });
  });

  it("stops the existing singleton poller before replacing it for a new interval", async () => {
    const { cloudUsagePollerModule } = await loadModulesWithTempDataDir();

    const firstPoller = await cloudUsagePollerModule.getCloudUsagePoller("machine-race-test", 1000);
    const stopSpy = vi.spyOn(firstPoller, "stop");
    vi.spyOn(firstPoller, "isRunning").mockReturnValue(true);

    const replacementPoller = await cloudUsagePollerModule.getCloudUsagePoller("machine-race-test", 2000);

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(replacementPoller).not.toBe(firstPoller);
    expect(replacementPoller.intervalMs).toBe(2000);
  });
});
