import * as log from "../utils/logger.js";
import { listMachines, getMachineData, deleteMachineData } from "../services/storage.js";

const RETENTION_DAYS = 7;

/**
 * Cleanup old machine data from R2
 * Runs daily via cron trigger
 */
export async function handleCleanup(env) {
  const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  
  log.info("CLEANUP", `Deleting records older than ${cutoffDate.toISOString()}`);
  
  try {
    const machineIds = await listMachines(env);
    let deleted = 0;
    
    for (const machineId of machineIds) {
      const data = await getMachineData(machineId, env);
      if (data?.updatedAt) {
        const updatedAt = new Date(data.updatedAt);
        if (updatedAt < cutoffDate) {
          await deleteMachineData(machineId, env);
          deleted++;
        }
      }
    }
    
    // Clean old usage/request logs (older than 30 days)
    const usageCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let usageDeleted = 0;
    
    for (const prefix of ["usage/", "requests/"]) {
      const listed = await env.R2_DATA.list({ prefix });
      for (const obj of listed.objects || []) {
        if (obj.uploaded && obj.uploaded < usageCutoff) {
          await env.R2_DATA.delete(obj.key);
          usageDeleted++;
        }
      }
    }
    
    log.info("CLEANUP", `Deleted ${deleted} old machine records, ${usageDeleted} old usage/request logs`);
    
    return {
      success: true,
      deleted,
      usageDeleted,
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
