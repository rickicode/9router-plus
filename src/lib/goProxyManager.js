import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGoProxyCommand } from "./goProxyRuntime.js";

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen({ port: Number(port), host: "127.0.0.1" }, () => {
      server.close(() => resolve(true));
    });
  });
}

class GoProxyManager {
  constructor() {
    this.process = null;
    this.logs = [];
    this.maxLogs = 50;
    this.retryCount = 0;
    this.maxRetries = 3;
    this.retryTimeouts = [1000, 2000, 4000]; // exponential backoff
    this.binaryPath = path.join(os.homedir(), ".9router", "bin", "9router-go-proxy");
    this.monitorInterval = null;
    this.healthCheckLatency = null;
    this.autoStartEnabled = false;
    this.lastConfig = null;
    
    // Start monitoring on initialization
    this.startMonitoring();
  }

  checkBinaryExists() {
    try {
      return fs.existsSync(this.binaryPath) && fs.statSync(this.binaryPath).isFile();
    } catch (error) {
      return false;
    }
  }

  async checkProcessRunning() {
    if (!this.process || !this.process.pid) {
      return false;
    }
    
    try {
      // Check if process is still alive
      process.kill(this.process.pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  async checkHealthWithLatency(port = 20138) {
    const startTime = Date.now();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(3000)
      });
      const latency = Date.now() - startTime;
      this.healthCheckLatency = latency;
      return { ok: response.ok, latency };
    } catch (error) {
      this.healthCheckLatency = null;
      return { ok: false, latency: null, error: error.message };
    }
  }

  async getDefaultConfig() {
    // Import here to avoid circular dependency
    const { getInternalProxyTokens } = await import("./internalProxyTokens.js");
    const { getSettings } = await import("./localDb.js");
    const path = await import("node:path");
    const os = await import("node:os");
    
    const tokens = await getInternalProxyTokens();
    const settings = await getSettings();
    const dataDir = settings?.dataDir || path.join(os.homedir(), ".9router", "data");
    const credentialsFile = path.join(dataDir, "credentials.json");
    
    return {
      binaryPath: this.binaryPath,
      host: "127.0.0.1",
      port: 20138,
      ninerouterBaseUrl: "http://localhost:20128",
      internalResolveToken: tokens.resolveToken,
      internalReportToken: tokens.reportToken,
      credentialsFile,
      httpTimeoutSeconds: 30,
    };
  }

  startMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }

    // Monitor every 5 seconds
    this.monitorInterval = setInterval(async () => {
      const binaryExists = this.checkBinaryExists();
      
      if (!binaryExists) {
        this.autoStartEnabled = false;
        return;
      }

      this.autoStartEnabled = true;
      const processRunning = await this.checkProcessRunning();
      
      // Auto-start if binary exists but process not running
      if (!processRunning) {
        const config = this.lastConfig || await this.getDefaultConfig();
        this.addLog("[MONITOR] Process not running, attempting auto-start...");
        try {
          await this.start(config);
        } catch (error) {
          this.addLog(`[MONITOR] Auto-start failed: ${error.message}`);
        }
      }
    }, 5000);
  }

  stopMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  async start(config) {
    if (this.process) {
      throw new Error("Go Proxy is already running");
    }

    // Check if binary exists
    if (!this.checkBinaryExists()) {
      const error = `Binary not found at ${this.binaryPath}`;
      this.addLog(`[ERROR] ${error}`);
      throw new Error(error);
    }

    // Check port availability
    const portAvailable = await isPortAvailable(config.port);
    if (!portAvailable) {
      const error = `Port ${config.port} is already in use. Stop the process using it first.`;
      this.addLog(`[ERROR] ${error}`);
      throw new Error(error);
    }

    // Store config for auto-restart
    this.lastConfig = config;

    const { file, args, env } = buildGoProxyCommand(config);
    
    this.addLog(`[INFO] Starting Go Proxy: ${file} ${args.join(" ")}`);
    console.log("[GoProxyManager] Starting:", file, args);
    
    try {
      this.process = spawn(file, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: { ...process.env, ...env },
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

    // Add immediate log to confirm manager is working
    this.addLog(`[INFO] Process spawned with PID ${this.process.pid}`);

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

  async restart(config) {
    if (this.process) {
      this.stop();
      // Wait for port to be released
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return await this.start(config);
  }

  handleExit(code, signal, config) {
    const exitReason = signal ? `signal ${signal}` : `code ${code}`;
    this.addLog(`[INFO] Process exited: ${exitReason}`);
    this.process = null;
    
    // Don't retry if port is in use or killed by signal
    const shouldRetry = code !== 0 && !signal && this.retryCount < this.maxRetries;
    
    if (shouldRetry) {
      const timeout = this.retryTimeouts[this.retryCount];
      this.addLog(`[WARN] Process exited with code ${code}, retrying in ${timeout}ms (attempt ${this.retryCount + 1}/${this.maxRetries})`);
      
      setTimeout(async () => {
        this.retryCount++;
        try {
          await this.start(config);
        } catch (error) {
          this.addLog(`[ERROR] Retry failed: ${error.message}`);
        }
      }, timeout);
    } else if (code !== 0 && !signal) {
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
      binaryPath: this.binaryPath,
      binaryExists: this.checkBinaryExists(),
      autoStartEnabled: this.autoStartEnabled,
      healthCheckLatency: this.healthCheckLatency,
    };
  }
}

export const goProxyManager = new GoProxyManager();
