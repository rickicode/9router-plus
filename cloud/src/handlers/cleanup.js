import * as log from "../utils/logger.js";
import { deleteRuntimeData } from "../services/storage.js";

const RETENTION_DAYS = 7;
const WORKER_RECORD_ID = "shared";

/**
 * Cleanup old worker registry/runtime data from D1.
 * Runs daily via cron trigger.
 */
export async function handleCleanup(env) {
  const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  log.info("CLEANUP", `Deleting worker records older than ${cutoffDate.toISOString()}`);

  try {
    // Keep the worker cleanup intentionally narrow: only unregister stale D1 worker state.
    const registryResult = env?.DB
      ? await env.DB.prepare(
          `SELECT updated_at FROM worker_registry WHERE worker_id = ?1`
        ).bind(WORKER_RECORD_ID).first()
      : null;

    let deleted = 0;
    if (registryResult?.updated_at) {
      const updatedAt = new Date(registryResult.updated_at);
      if (updatedAt < cutoffDate) {
        await deleteRuntimeData(WORKER_RECORD_ID, env);
        deleted = 1;
      }
    }

    log.info("CLEANUP", `Deleted ${deleted} stale worker registry records`);

    return {
      success: true,
      deleted,
      cutoffDate: cutoffDate.toISOString()
    };
  } catch (error) {
    log.error("CLEANUP", error.message);
    return {
      success: false,
      error: error.message
    };
  }
}
