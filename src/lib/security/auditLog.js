// src/lib/security/auditLog.js
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";

const DEFAULT_LOG_FILE = path.join(DATA_DIR, "audit.log");
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10MB

class AuditLogger {
  constructor() {
    this.enabled = true;
    this.maxSize = DEFAULT_MAX_SIZE;
  }

  rotate(logFile) {
    try {
      // Shift existing rotated files (.3 → delete, .2 → .3, .1 → .2)
      for (let i = 3; i >= 1; i--) {
        const oldFile = logFile + "." + i;
        const newFile = logFile + "." + (i + 1);
        
        if (fs.existsSync(oldFile)) {
          if (i === 3) {
            // Delete .3 (only keep 3 rotated files)
            fs.unlinkSync(oldFile);
          } else {
            fs.renameSync(oldFile, newFile);
          }
        }
      }

      // Move current log to .1
      if (fs.existsSync(logFile)) {
        fs.renameSync(logFile, logFile + ".1");
      }
    } catch (error) {
      console.error("[AuditLog] Failed to rotate log:", error.message);
    }
  }

  log(event, data, logFile = DEFAULT_LOG_FILE) {
    if (!this.enabled) return;

    try {
      const entry = {
        timestamp: new Date().toISOString(),
        event,
        ...data
      };

      const line = JSON.stringify(entry) + "\n";
      
      // Ensure directory exists
      const dir = path.dirname(logFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Check if rotation needed
      if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        if (stats.size >= this.maxSize) {
          this.rotate(logFile);
        }
      }

      // Append to file
      fs.appendFileSync(logFile, line, "utf-8");
    } catch (error) {
      console.error("[AuditLog] Failed to write log:", error.message);
    }
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  setMaxSize(size) {
    this.maxSize = size;
  }
}

export const auditLog = new AuditLogger();
export { AuditLogger }; // Export class for testing
