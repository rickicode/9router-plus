/**
 * Credential import orchestration
 *
 * Behavior:
 *   - Always upserts: existing connections matched by id/email/name/fingerprint
 *     are updated, anything else becomes a new connection.
 *   - Never deletes existing connections that are not present in the payload.
 *     Imports are strictly additive — there is no "replace" mode anymore.
 */

import {
  createProviderConnection,
  getProviderConnections,
  updateProviderConnection,
} from "@/lib/localDb";
import { ConnectionMatcher, validateNoDuplicateImports } from "./matcher";
import { normalizeInputRecord, extractInputRecords } from "./normalizer";
import { sanitizeCredentialRecord } from "./validator";

export async function importCredentials(payload) {
  const inputRecords = extractInputRecords(payload);
  if (!inputRecords) {
    const error = new Error("Payload must contain credentials array or equivalent entries");
    error.code = "INVALID_IMPORT_PAYLOAD";
    error.status = 400;
    throw error;
  }

  // Normalize all records first
  const normalizedRecords = [];
  const skipReasons = [];

  for (const item of inputRecords) {
    const index = normalizedRecords.length + skipReasons.length + 1;
    const normalized = normalizeInputRecord(item);
    if (!normalized) {
      skipReasons.push({
        index,
        code: "INVALID_RECORD",
        message: "Credential record must be an object",
      });
      continue;
    }

    try {
      const sanitized = sanitizeCredentialRecord(normalized);

      normalizedRecords.push({
        index,
        sourceId: typeof normalized.id === "string" ? normalized.id : null,
        data: sanitized,
      });
    } catch (error) {
      skipReasons.push({
        index,
        code: error?.code || "INVALID_RECORD",
        message: error?.message || "Credential record is invalid",
      });
    }
  }

  // Validate no duplicate imports
  const duplicates = validateNoDuplicateImports(
    normalizedRecords.map((r) => r.data),
  );
  if (duplicates.length > 0) {
    const details = duplicates
      .map((d) => `Record ${d.index} duplicates record ${d.firstIndex} (${d.key})`)
      .join("; ");
    const error = new Error(`Duplicate import records detected: ${details}`);
    error.code = "DUPLICATE_IMPORT_RECORDS";
    error.status = 400;
    throw error;
  }

  // Fetch existing connections and build matcher
  const existing = await getProviderConnections();
  const matcher = new ConnectionMatcher(existing);
  const restoredIds = new Set();

  let created = 0;
  let updated = 0;

  for (const { sourceId, data } of normalizedRecords) {
    const existingConnection = matcher.findMatch(data, sourceId);

    if (existingConnection) {
      await updateProviderConnection(existingConnection.id, data);
      matcher.updateConnection(existingConnection.id, data);
      matcher.markProcessed(existingConnection.id);
      restoredIds.add(existingConnection.id);
      updated += 1;
    } else {
      if (data.authType === "apikey" && !data.name) {
        skipReasons.push({
          code: "INVALID_RECORD",
          message: "API key credential record is missing name",
        });
        continue;
      }

      const createdConnection = await createProviderConnection(data);
      matcher.addConnection(createdConnection);
      matcher.markProcessed(createdConnection.id);
      restoredIds.add(createdConnection.id);
      created += 1;
    }
  }

  return {
    created,
    updated,
    deleted: 0,
    skipped: skipReasons.length,
    imported: created + updated,
    skipReasons,
  };
}
