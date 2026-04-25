import { beforeEach, describe, expect, it, vi } from "vitest";

const SHUTDOWN_HANDLER_REGISTRY_KEY = Symbol.for("9routerPlus.requestDetailsDb.shutdownHandlers");

const getSettings = vi.fn(async () => ({
  enableObservability: true,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 60_000,
  observabilityMaxRecords: 200,
  observabilityMaxJsonSize: 5,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings,
}));

vi.mock("@/lib/dataDir.js", () => ({
  DATA_DIR: "/tmp/9router-tests",
}));

const state = {
  records: [],
  writeCalls: 0,
  writeImpl: async () => {},
};

vi.mock("lowdb", () => ({
  Low: class {
    constructor() {
      this.data = { records: state.records };
    }

    async read() {
      this.data = { records: state.records };
    }

    async write() {
      state.records = [...this.data.records];
      state.writeCalls += 1;
      await state.writeImpl();
    }
  },
}));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, maxTicks = 100) {
  for (let i = 0; i < maxTicks; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for condition");
}

vi.mock("lowdb/node", () => ({
  JSONFile: class {
    constructor() {}
  },
}));

describe("requestDetailsDb visibility", () => {
  beforeEach(() => {
    const shutdownHandlers = globalThis[SHUTDOWN_HANDLER_REGISTRY_KEY];
    if (shutdownHandlers?.beforeExit) process.off("beforeExit", shutdownHandlers.beforeExit);
    if (shutdownHandlers?.SIGINT) process.off("SIGINT", shutdownHandlers.SIGINT);
    if (shutdownHandlers?.SIGTERM) process.off("SIGTERM", shutdownHandlers.SIGTERM);
    delete globalThis[SHUTDOWN_HANDLER_REGISTRY_KEY];

    vi.resetModules();
    getSettings.mockClear();
    state.records = [];
    state.writeCalls = 0;
    state.writeImpl = async () => {};
  });

  async function importRequestDetailsDbWithSignalHandlers() {
    const sigtermHandlersBefore = new Set(process.listeners("SIGTERM"));
    const module = await import("../../src/lib/requestDetailsDb.js");
    const sigtermHandler = process.listeners("SIGTERM").find((handler) => !sigtermHandlersBefore.has(handler));

    if (!sigtermHandler) {
      throw new Error("Failed to locate requestDetailsDb SIGTERM handler");
    }

    return { ...module, sigtermHandler };
  }

  it("returns buffered records in read results before the next flush", async () => {
    const { saveRequestDetail, getRequestDetails, getRequestDetailById } = await import("../../src/lib/requestDetailsDb.js");

    await saveRequestDetail({
      id: "detail-buffered",
      provider: "openai",
      model: "gpt-4.1",
      timestamp: "2026-04-25T00:00:00.000Z",
      status: 200,
    });

    const results = await getRequestDetails({ page: 1, pageSize: 10 });

    expect(state.writeCalls).toBe(0);
    expect(results.details).toEqual([
      expect.objectContaining({
        id: "detail-buffered",
        provider: "openai",
        model: "gpt-4.1",
      }),
    ]);
    await expect(getRequestDetailById("detail-buffered")).resolves.toMatchObject({
      id: "detail-buffered",
      provider: "openai",
      model: "gpt-4.1",
    });
  });

  it("keeps records visible while a flush is in progress", async () => {
    const pendingWrite = deferred();
    state.writeImpl = vi
      .fn()
      .mockImplementationOnce(async () => await pendingWrite.promise)
      .mockImplementation(async () => {});

    const { saveRequestDetail, getRequestDetails, getRequestDetailById } = await import("../../src/lib/requestDetailsDb.js");

    const savePromise = saveRequestDetail({
      id: "detail-in-flight",
      provider: "openai",
      model: "gpt-4.1",
      timestamp: "2026-04-25T00:00:00.000Z",
      status: 200,
    }, { propagateError: true });

    await waitFor(() => state.writeCalls >= 1);

    const results = await getRequestDetails({ page: 1, pageSize: 10 });
    expect(results.details).toEqual([
      expect.objectContaining({
        id: "detail-in-flight",
        provider: "openai",
        model: "gpt-4.1",
      }),
    ]);
    await expect(getRequestDetailById("detail-in-flight")).resolves.toMatchObject({
      id: "detail-in-flight",
      provider: "openai",
      model: "gpt-4.1",
    });

    pendingWrite.resolve();
    await savePromise;
  });

  it("waits for an in-flight flush during shutdown even when the buffer is empty", async () => {
    const pendingWrite = deferred();
    state.writeImpl = vi
      .fn()
      .mockImplementationOnce(async () => await pendingWrite.promise)
      .mockImplementation(async () => {});

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined);

    try {
      const { saveRequestDetail, sigtermHandler } = await importRequestDetailsDbWithSignalHandlers();

      const savePromise = saveRequestDetail({
        id: "detail-shutdown-in-flight",
        provider: "openai",
        model: "gpt-4.1",
        timestamp: "2026-04-25T00:00:00.000Z",
        status: 200,
      }, { propagateError: true });

      await waitFor(() => state.writeCalls >= 1);

      let shutdownResolved = false;
      const shutdownPromise = sigtermHandler().then(() => {
        shutdownResolved = true;
      });

      await Promise.resolve();
      expect(shutdownResolved).toBe(false);
      expect(exitSpy).not.toHaveBeenCalled();

      pendingWrite.resolve();

      await shutdownPromise;
      await savePromise;

      expect(shutdownResolved).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(143);
      expect(state.records).toEqual([
        expect.objectContaining({
          id: "detail-shutdown-in-flight",
          provider: "openai",
          model: "gpt-4.1",
        }),
      ]);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("keeps shutdown listener counts stable across module reloads", async () => {
    const baselineCounts = {
      beforeExit: process.listeners("beforeExit").length,
      SIGINT: process.listeners("SIGINT").length,
      SIGTERM: process.listeners("SIGTERM").length,
    };

    await import("../../src/lib/requestDetailsDb.js");

    const countsAfterFirstImport = {
      beforeExit: process.listeners("beforeExit").length,
      SIGINT: process.listeners("SIGINT").length,
      SIGTERM: process.listeners("SIGTERM").length,
    };

    expect(countsAfterFirstImport).toEqual({
      beforeExit: baselineCounts.beforeExit + 1,
      SIGINT: baselineCounts.SIGINT + 1,
      SIGTERM: baselineCounts.SIGTERM + 1,
    });

    vi.resetModules();
    await import("../../src/lib/requestDetailsDb.js");

    expect({
      beforeExit: process.listeners("beforeExit").length,
      SIGINT: process.listeners("SIGINT").length,
      SIGTERM: process.listeners("SIGTERM").length,
    }).toEqual(countsAfterFirstImport);

    vi.resetModules();
    await import("../../src/lib/requestDetailsDb.js");

    expect({
      beforeExit: process.listeners("beforeExit").length,
      SIGINT: process.listeners("SIGINT").length,
      SIGTERM: process.listeners("SIGTERM").length,
    }).toEqual(countsAfterFirstImport);
  });
});
