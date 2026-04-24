import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("lowdb/node", () => ({
  JSONFile: class {
    constructor() {}
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

describe("requestDetailsDb propagateError durability", () => {
  beforeEach(() => {
    vi.resetModules();
    getSettings.mockClear();
    state.records = [];
    state.writeCalls = 0;
    state.writeImpl = async () => {};
  });

  it("waits for in-flight flush and durably persists the new detail", async () => {
    const firstWrite = deferred();
    state.writeImpl = vi
      .fn()
      .mockImplementationOnce(async () => await firstWrite.promise)
      .mockImplementation(async () => {});

    const { saveRequestDetail, getRequestDetailById } = await import("../../src/lib/requestDetailsDb.js");

    const p1 = saveRequestDetail({ id: "detail-1", model: "gpt-4" }, { propagateError: true });

    await Promise.resolve();

    let secondSettled = false;
    const p2 = saveRequestDetail({ id: "detail-2", model: "gpt-4" }, { propagateError: true })
      .then(() => {
        secondSettled = true;
      });

    await Promise.resolve();
    expect(secondSettled).toBe(false);

    firstWrite.resolve();
    await Promise.all([p1, p2]);

    expect(state.writeCalls).toBeGreaterThanOrEqual(2);
    await expect(getRequestDetailById("detail-1")).resolves.toMatchObject({ id: "detail-1" });
    await expect(getRequestDetailById("detail-2")).resolves.toMatchObject({ id: "detail-2" });
  });

  it("throws explicitly when queued durable flush fails", async () => {
    const firstWrite = deferred();
    const flushError = new Error("disk full");

    state.writeImpl = vi
      .fn()
      .mockImplementationOnce(async () => await firstWrite.promise)
      .mockImplementation(async () => {
        throw flushError;
      });

    const { saveRequestDetail } = await import("../../src/lib/requestDetailsDb.js");

    const p1 = saveRequestDetail({ id: "detail-a", model: "gpt-4" }, { propagateError: true });

    await waitFor(() => state.writeCalls >= 1);

    const p2 = saveRequestDetail({ id: "detail-b", model: "gpt-4" }, { propagateError: true });

    firstWrite.resolve();
    await p1;
    await expect(p2).rejects.toThrow("disk full");
  });
});
