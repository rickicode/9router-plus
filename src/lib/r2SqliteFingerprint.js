import crypto from "node:crypto";
import fs from "node:fs";
import { DB_SQLITE_FILE } from "@/lib/sqliteHelpers.js";

export function computeSqliteFingerprint({
  filePath = DB_SQLITE_FILE,
  fsImpl = fs,
} = {}) {
  if (!fsImpl.existsSync(filePath)) {
    throw new Error(`SQLite file not found: ${filePath}`);
  }

  const data = fsImpl.readFileSync(filePath);
  const fingerprint = crypto.createHash("sha256").update(data).digest("hex");

  return {
    filePath,
    data,
    fingerprint,
  };
}

export function hasSqliteChanged({
  nextFingerprint,
  previousFingerprint,
} = {}) {
  if (typeof nextFingerprint !== "string" || !nextFingerprint) {
    throw new Error("nextFingerprint is required");
  }

  return nextFingerprint !== previousFingerprint;
}
