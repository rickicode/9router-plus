/**
 * Credential import orchestration
 */

import {
  createProviderConnection,
  deleteProviderConnection,
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

  const replaceMode = payload?.mode === "replace";

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
      if (replaceMode && sanitized.authType === "apikey" && !sanitized.name) {
        const error = new Error("API key credential record is missing name");
        error.code = "INVALID_RECORD";
        throw error;
      }

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

  if (replaceMode && skipReasons.length > 0) {
    const error = new Error("Replace-mode restore aborted because one or more credential records are invalid");
    error.code = "REPLACE_MODE_VALIDATION_FAILED";
    error.invalidRecords = skipReasons;
    throw error;
  }

  // Fetch existing connections and build matcher
  const existing = await getProviderConnections();
  const matcher = new ConnectionMatcher(existing);
  const restoredIds = new Set();
  const createdConnectionIds = [];

  let created = 0;
  let updated = 0;
  let deleted = 0;

  async function rollbackReplaceMode() {
    for (const createdId of createdConnectionIds) {
      try {
        await deleteProviderConnection(createdId);
      } catch {}
    }

    const currentConnections = await getProviderConnections();
    const currentIds = new Set(currentConnections.map((connection) => connection.id));

    for (const originalConnection of existing) {
      const currentConnection = currentIds.has(originalConnection.id);

      if (!currentConnection) {
        await createProviderConnection(originalConnection);
        continue;
      }

      await updateProviderConnection(originalConnection.id, originalConnection);
    }
  }

  try {
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
        createdConnectionIds.push(createdConnection.id);
        matcher.addConnection(createdConnection);
        matcher.markProcessed(createdConnection.id);
        restoredIds.add(createdConnection.id);
        created += 1;
      }
    }

    if (replaceMode) {
      for (const connection of existing) {
        if (!restoredIds.has(connection.id)) {
          const didDelete = await deleteProviderConnection(connection.id);
          if (didDelete) deleted += 1;
        }
      }
    }
  } catch (error) {
    if (replaceMode) {
      await rollbackReplaceMode();
    }
    throw error;
  }

  return {
    created,
    updated,
    deleted,
    skipped: skipReasons.length,
    imported: created + updated,
    skipReasons,
  };
}
