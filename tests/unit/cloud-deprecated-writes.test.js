import { describe, expect, it } from "vitest";

import { handleSync } from "../../cloud/src/handlers/sync.js";
import { handleSqliteBackupUpload } from "../../cloud/src/handlers/r2backup.js";

describe("deprecated worker-side write paths", () => {
  it("rejects sync POST writes with runtimeUrl guidance", async () => {
    const response = await handleSync(
      new Request("https://worker.example.com/sync/machine-1", { method: "POST" }),
      {},
      {}
    );
    const payload = await response.json();

    expect(response.status).toBe(410);
    expect(payload.error).toContain("Sync writes are deprecated");
    expect(payload.runtimeUrlRequired).toBe(true);
  });

  it("rejects worker-side SQLite backup uploads", async () => {
    const response = await handleSqliteBackupUpload(
      new Request("https://worker.example.com/r2/backup/sqlite/machine-1", { method: "POST" }),
      {}
    );
    const payload = await response.json();

    expect(response.status).toBe(410);
    expect(payload.error).toContain("deprecated");
    expect(payload.writer).toBe("9router-plus");
  });
});
