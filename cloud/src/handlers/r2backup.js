import * as log from "../utils/logger.js";
import {
  getMachineData,
  exportMachineData,
  saveSqliteBackup,
  listSqliteBackups,
  getSqliteBackup,
  saveUsageData,
  saveRequestLog,
  listMachines
} from "../services/storage.js";
import { extractSecret, isSecretValid } from "../utils/secret.js";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}

async function authorize(request, machineId, env) {
  const data = await getMachineData(machineId, env);
  const presented = extractSecret(request);

  if (!data) {
    return { ok: false, response: jsonResponse({ error: "Machine not registered" }, 404) };
  }

  if (!isSecretValid(presented, data)) {
    return { ok: false, response: jsonResponse({ error: "Unauthorized" }, 401) };
  }

  return { ok: true, data };
}

/**
 * POST /r2/backup/sqlite/:machineId - Upload SQLite backup
 */
export async function handleSqliteBackupUpload(request, env) {
  const url = new URL(request.url);
  const machineId = url.pathname.split("/")[4];

  if (!machineId) {
    return jsonResponse({ error: "Missing machineId" }, 400);
  }

  const auth = await authorize(request, machineId, env);
  if (!auth.ok) return auth.response;

  try {
    const data = await request.arrayBuffer();
    if (!data || data.byteLength === 0) {
      return jsonResponse({ error: "Empty backup data" }, 400);
    }

    const key = await saveSqliteBackup(data, env);
    log.info("R2BACKUP", `SQLite backup uploaded for ${machineId}: ${key} (${data.byteLength} bytes)`);

    return jsonResponse({
      success: true,
      key,
      size: data.byteLength,
      uploadedAt: new Date().toISOString()
    });
  } catch (error) {
    log.error("R2BACKUP", `SQLite backup upload failed: ${error.message}`);
    return jsonResponse({ error: error.message }, 500);
  }
}

/**
 * GET /r2/backup/sqlite - List all SQLite backups
 */
export async function handleSqliteBackupList(request, env) {
  const url = new URL(request.url);
  const machineId = url.searchParams.get("machineId");

  if (!machineId) {
    return jsonResponse({ error: "Missing machineId query param" }, 400);
  }

  const auth = await authorize(request, machineId, env);
  if (!auth.ok) return auth.response;

  try {
    const backups = await listSqliteBackups(env);
    return jsonResponse({ success: true, backups });
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

/**
 * GET /r2/backup/sqlite/:key - Download a specific SQLite backup
 */
export async function handleSqliteBackupDownload(request, env) {
  const url = new URL(request.url);
  const machineId = url.searchParams.get("machineId");

  if (!machineId) {
    return jsonResponse({ error: "Missing machineId query param" }, 400);
  }

  const auth = await authorize(request, machineId, env);
  if (!auth.ok) return auth.response;

  // Extract key from path: /r2/backup/sqlite/download?key=...
  const key = url.searchParams.get("key");
  if (!key) {
    return jsonResponse({ error: "Missing key query param" }, 400);
  }

  try {
    const data = await getSqliteBackup(key, env);
    if (!data) {
      return jsonResponse({ error: "Backup not found" }, 404);
    }

    return new Response(data, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${key.split("/").pop()}"`,
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

/**
 * GET /r2/export/:machineId - Export all data for restore/rollback
 */
export async function handleExportData(request, env) {
  const url = new URL(request.url);
  const machineId = url.pathname.split("/")[3];

  if (!machineId) {
    return jsonResponse({ error: "Missing machineId" }, 400);
  }

  const auth = await authorize(request, machineId, env);
  if (!auth.ok) return auth.response;

  try {
    const exportData = await exportMachineData(machineId, env);
    return jsonResponse({
      success: true,
      ...exportData
    });
  } catch (error) {
    log.error("R2BACKUP", `Export failed: ${error.message}`);
    return jsonResponse({ error: error.message }, 500);
  }
}

/**
 * POST /r2/usage/:machineId - Save usage data backup
 */
export async function handleUsageBackup(request, env) {
  const url = new URL(request.url);
  const machineId = url.pathname.split("/")[3];

  if (!machineId) {
    return jsonResponse({ error: "Missing machineId" }, 400);
  }

  const auth = await authorize(request, machineId, env);
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json();
    await saveUsageData(machineId, body, env);
    return jsonResponse({ success: true });
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

/**
 * POST /r2/requests/:machineId - Save request log backup
 */
export async function handleRequestLogBackup(request, env) {
  const url = new URL(request.url);
  const machineId = url.pathname.split("/")[3];

  if (!machineId) {
    return jsonResponse({ error: "Missing machineId" }, 400);
  }

  const auth = await authorize(request, machineId, env);
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json();
    await saveRequestLog(machineId, body, env);
    return jsonResponse({ success: true });
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

/**
 * GET /r2/info - Get R2 storage info (machines list, backup count)
 */
export async function handleR2Info(request, env) {
  const url = new URL(request.url);
  const machineId = url.searchParams.get("machineId");

  if (!machineId) {
    return jsonResponse({ error: "Missing machineId query param" }, 400);
  }

  const auth = await authorize(request, machineId, env);
  if (!auth.ok) return auth.response;

  try {
    const machines = await listMachines(env);
    const backups = await listSqliteBackups(env);

    return jsonResponse({
      success: true,
      storage: "r2",
      machines,
      machineCount: machines.length,
      backupCount: backups.length,
      latestBackup: backups.length > 0 ? backups[backups.length - 1] : null
    });
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}
