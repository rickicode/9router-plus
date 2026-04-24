import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildGoProxyCommand,
  createDefaultRuntimeState,
  assertGoProxyRuntimeCommandReady,
  startGoProxyRuntime,
  restartGoProxyRuntime,
  getGoProxyRuntimeStatus,
  resetGoProxyRuntimeState,
} from "../../src/lib/goProxyRuntime.js";

describe("goProxyRuntime", () => {
  it("builds direct exec args from runtime state", () => {
    const runtime = {
      binaryPath: "/home/test/.9router/bin/9router-go-proxy",
      host: "127.0.0.1",
      port: 20138,
      baseUrl: "http://127.0.0.1:20129",
      resolveToken: "resolve-token",
      reportToken: "report-token",
      credentialsFile: "/tmp/db.json",
    };

    expect(buildGoProxyCommand(runtime)).toEqual({
      file: "/home/test/.9router/bin/9router-go-proxy",
      args: [
        "--listen-host",
        "127.0.0.1",
        "--listen-port",
        "20138",
        "--base-url",
        "http://127.0.0.1:20129",
        "--internal-resolve-token",
        "resolve-token",
        "--internal-report-token",
        "report-token",
        "--credentials-file",
        "/tmp/db.json",
      ],
    });
  });

  it("start preflight fails when command contract fields are missing", async () => {
    resetGoProxyRuntimeState();

    await expect(
      startGoProxyRuntime({
        enabled: true,
        running: false,
        status: "stopped",
      }),
    ).rejects.toThrowError(
      "[Go Proxy Runtime] Missing required runtime command field(s): host, port, ninerouterBaseUrl, internalResolveToken, internalReportToken, credentialsFile",
    );
  });

  it("defaults to a stopped runtime state", () => {
    expect(createDefaultRuntimeState()).toEqual({
      enabled: false,
      running: false,
      status: "stopped",
      pid: null,
      host: null,
      port: null,
      binaryPath: path.join(os.homedir(), ".9router", "bin", "9router-go-proxy"),
      startedAt: null,
      lastHealthAt: null,
      lastExitCode: null,
      lastError: null,
    });
  });

  it("builds direct binary command args from runtime contract", () => {
    const runtime = {
      binaryPath: path.join(os.homedir(), ".9router", "bin", "9router-go-proxy"),
      host: "127.0.0.1",
      port: 8080,
      ninerouterBaseUrl: "http://127.0.0.1:20128",
      internalResolveToken: "resolve-token",
      internalReportToken: "report-token",
      credentialsFile: path.join(os.homedir(), ".9router", "db.json"),
    };

    expect(buildGoProxyCommand(runtime)).toEqual({
      file: path.join(os.homedir(), ".9router", "bin", "9router-go-proxy"),
      args: [
        "--listen-host",
        "127.0.0.1",
        "--listen-port",
        "8080",
        "--base-url",
        "http://127.0.0.1:20128",
        "--internal-resolve-token",
        "resolve-token",
        "--internal-report-token",
        "report-token",
        "--credentials-file",
        path.join(os.homedir(), ".9router", "db.json"),
      ],
    });
  });

  it("includes http timeout seconds flag when provided", () => {
    const runtime = {
      binaryPath: path.join(os.homedir(), ".9router", "bin", "9router-go-proxy"),
      host: "127.0.0.1",
      port: 8080,
      ninerouterBaseUrl: "http://127.0.0.1:20128",
      internalResolveToken: "resolve-token",
      internalReportToken: "report-token",
      credentialsFile: path.join(os.homedir(), ".9router", "db.json"),
      httpTimeoutSeconds: 25,
    };

    expect(buildGoProxyCommand(runtime).args).toEqual([
      "--listen-host",
      "127.0.0.1",
      "--listen-port",
      "8080",
      "--base-url",
      "http://127.0.0.1:20128",
      "--internal-resolve-token",
      "resolve-token",
      "--internal-report-token",
      "report-token",
      "--credentials-file",
      path.join(os.homedir(), ".9router", "db.json"),
      "--http-timeout-seconds",
      "25",
    ]);
  });

  it("throws preflight error when required runtime command fields are missing", () => {
    expect(() =>
      assertGoProxyRuntimeCommandReady({
        host: "127.0.0.1",
        port: 8080,
        ninerouterBaseUrl: "http://127.0.0.1:20128",
      }),
    ).toThrowError(
      "[Go Proxy Runtime] Missing required runtime command field(s): binaryPath, internalResolveToken, internalReportToken, credentialsFile",
    );
  });

  it("verifies runtime-manager start state before marking runtime as running", async () => {
    resetGoProxyRuntimeState();

    await expect(
      startGoProxyRuntime({
        host: "127.0.0.1",
        port: 8080,
        ninerouterBaseUrl: "http://127.0.0.1:20128",
        internalResolveToken: "resolve-token",
        internalReportToken: "report-token",
        credentialsFile: path.join(os.homedir(), ".9router", "db.json"),
        verifyRuntimeManager: () => ({ ok: false, error: "runtime-manager unavailable" }),
      }),
    ).rejects.toThrowError("[Go Proxy Runtime] Runtime manager verification failed: runtime-manager unavailable");

    expect(getGoProxyRuntimeStatus()).toMatchObject({
      enabled: false,
      running: false,
      status: "stopped",
      lastError: "runtime-manager unavailable",
    });
  });

  it("rolls back restart when runtime-manager verification fails", async () => {
    resetGoProxyRuntimeState({
      enabled: true,
      running: true,
      status: "running",
      host: "127.0.0.1",
      port: 8080,
      ninerouterBaseUrl: "http://127.0.0.1:20128",
      internalResolveToken: "resolve-token",
      internalReportToken: "report-token",
      credentialsFile: path.join(os.homedir(), ".9router", "db.json"),
      startedAt: "2026-04-23T00:00:00.000Z",
    });

    await expect(
      restartGoProxyRuntime({
        verifyRuntimeManager: () => ({ ok: false, error: "health check failed" }),
      }),
    ).rejects.toThrowError("[Go Proxy Runtime] Runtime manager verification failed: health check failed");

    expect(getGoProxyRuntimeStatus()).toMatchObject({
      enabled: true,
      running: true,
      status: "running",
      host: "127.0.0.1",
      port: 8080,
      ninerouterBaseUrl: "http://127.0.0.1:20128",
      internalResolveToken: "resolve-token",
      internalReportToken: "report-token",
      credentialsFile: path.join(os.homedir(), ".9router", "db.json"),
      startedAt: "2026-04-23T00:00:00.000Z",
      lastError: "health check failed",
    });
  });
});
