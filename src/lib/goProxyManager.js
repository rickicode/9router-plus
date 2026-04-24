import { spawn } from "node:child_process";
import { buildGoProxyCommand } from "./goProxyRuntime.js";

class GoProxyManager {
  constructor() {
    this.process = null;
    this.logs = [];
    this.maxLogs = 50;
    this.retryCount = 0;
    this.maxRetries = 3;
    this.retryTimeouts = [1000, 2000, 4000]; // exponential backoff
  }

  start(config) {
    if (this.process) {
      throw new Error("Go Proxy is already running");
    }

    const { file, args } = buildGoProxyCommand(config);
    
    this.addLog(`[INFO] Starting Go Proxy: ${file} ${args.join(" ")}`);
    console.log("[GoProxyManager] Starting:", file, args);
    
    try {
      this.process = spawn(file, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
      console.log("[GoProxyManager] Spawned PID:", this.process.pid);
    } catch (error) {
      console.error("[GoProxyManager] Spawn error:", error);
      this.addLog(`[ERROR] Failed to spawn process: ${error.message}`);
      throw error;
    }

    this.process.on("error", (error) => {
      console.error("[GoProxyManager] Process error:", error);
      this.addLog(`[ERROR] Process error: ${error.message}`);
      this.process = null;
    });

    this.process.stdout.on("data", (data) => {
      const msg = data.toString().trim();
      console.log("[GoProxyManager] STDOUT:", msg);
      this.addLog(`[INFO] ${msg}`);
    });

    this.process.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      console.error("[GoProxyManager] STDERR:", msg);
      this.addLog(`[INFO] ${msg}`);  // Go logs to stderr by default
    });

    this.process.on("exit", (code, signal) => {
      console.log("[GoProxyManager] Exit:", code, signal);
      this.handleExit(code, signal, config);
    });

    return {
      pid: this.process.pid,
      startedAt: new Date().toISOString(),
    };
  }

  stop() {
    if (!this.process) {
      throw new Error("Go Proxy is not running");
    }

    this.process.kill("SIGTERM");
    this.process = null;
    this.retryCount = 0;
  }

  restart(config) {
    if (this.process) {
      this.stop();
    }
    return this.start(config);
  }

  handleExit(code, signal, config) {
    const exitReason = signal ? `signal ${signal}` : `code ${code}`;
    this.addLog(`[INFO] Process exited: ${exitReason}`);
    this.process = null;
    
    if (code !== 0 && !signal && this.retryCount < this.maxRetries) {
      const timeout = this.retryTimeouts[this.retryCount];
      this.addLog(`[WARN] Process exited with code ${code}, retrying in ${timeout}ms (attempt ${this.retryCount + 1}/${this.maxRetries})`);
      
      setTimeout(() => {
        this.retryCount++;
        try {
          this.start(config);
        } catch (error) {
          this.addLog(`[ERROR] Retry failed: ${error.message}`);
        }
      }, timeout);
    } else if (code !== 0) {
      this.addLog(`[ERROR] Process stopped after ${this.maxRetries} retry attempts (exit code: ${code})`);
      this.retryCount = 0;
    } else {
      this.addLog(`[INFO] Process stopped gracefully`);
      this.retryCount = 0;
    }
  }

  addLog(message) {
    const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
    const logEntry = `[${timestamp}] ${message}`;
    this.logs.push(logEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  getLogs() {
    return this.logs;
  }

  getStatus() {
    const lastLog = this.logs[this.logs.length - 1];
    const hasError = lastLog && lastLog.includes("[ERROR]");
    
    return {
      running: this.process !== null,
      pid: this.process?.pid || null,
      retryCount: this.retryCount,
      lastError: hasError ? lastLog : null,
      logsCount: this.logs.length,
    };
  }
}

export const goProxyManager = new GoProxyManager();
