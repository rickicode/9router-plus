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
    
    this.process = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    this.process.stdout.on("data", (data) => {
      this.addLog(`[INFO] ${data.toString().trim()}`);
    });

    this.process.stderr.on("data", (data) => {
      this.addLog(`[ERROR] ${data.toString().trim()}`);
    });

    this.process.on("exit", (code) => {
      this.handleExit(code, config);
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

  handleExit(code, config) {
    this.process = null;
    
    if (code !== 0 && this.retryCount < this.maxRetries) {
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
    return {
      running: this.process !== null,
      pid: this.process?.pid || null,
      retryCount: this.retryCount,
    };
  }
}

export const goProxyManager = new GoProxyManager();
