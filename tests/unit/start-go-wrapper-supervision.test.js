import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  assertGoProxyWrapperAuthConfigured,
  resolveGoProxyWrapperOptions,
  resolveStandaloneServerPath,
  shouldSyncStandaloneAssets,
  spawnGoProxyWrapper,
  superviseGoProxyWrapper,
  waitForHttpHealth,
} from "../../scripts/start.js";

describe("go proxy wrapper startup auth preflight", () => {
  it("throws when resolve token is missing", () => {
    expect(() =>
      assertGoProxyWrapperAuthConfigured({
        INTERNAL_PROXY_REPORT_TOKEN: "report-token",
      }),
    ).toThrowError("[Go Wrapper] Missing required internal auth token(s): INTERNAL_PROXY_RESOLVE_TOKEN");
  });

  it("throws when report token is missing", () => {
    expect(() =>
      assertGoProxyWrapperAuthConfigured({
        INTERNAL_PROXY_RESOLVE_TOKEN: "resolve-token",
      }),
    ).toThrowError("[Go Wrapper] Missing required internal auth token(s): INTERNAL_PROXY_REPORT_TOKEN");
  });

  it("passes when both internal tokens are configured", () => {
    expect(() =>
      assertGoProxyWrapperAuthConfigured({
        INTERNAL_PROXY_RESOLVE_TOKEN: "resolve-token",
        INTERNAL_PROXY_REPORT_TOKEN: "report-token",
      }),
    ).not.toThrow();
  });
});

describe("go proxy wrapper supervision config", () => {
  it("defaults to disabled wrapper supervision", () => {
    const options = resolveGoProxyWrapperOptions({});
    expect(options.enabled).toBe(false);
  });

  it("marks start.js wrapper config as legacy compatibility bootstrap", () => {
    const options = resolveGoProxyWrapperOptions({
      GO_PROXY_WRAPPER_ENABLED: "true",
      GO_PROXY_WRAPPER_HOST: "127.0.0.1",
      GO_PROXY_WRAPPER_PORT: "8080",
    });

    expect(options.enabled).toBe(true);
    expect(options.mode).toBe("compatibility-bootstrap");
    expect(options.primaryRuntimeContract).toBe("go-proxy runtime control API");
    expect(options.healthUrl).toBe("http://127.0.0.1:8080/health");
  });
});

describe("standalone runtime detection", () => {
  it("prefers Docker-style /app/server.js when present", () => {
    const fakeCwd = "/tmp/9router-standalone-docker";
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(fakeCwd);
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((filePath) => {
      return filePath === path.join(fakeCwd, "server.js");
    });

    try {
      const resolved = resolveStandaloneServerPath(process.cwd());
      expect(resolved).toBe(path.join(fakeCwd, "server.js"));
      expect(shouldSyncStandaloneAssets(resolved)).toBe(false);
    } finally {
      existsSpy.mockRestore();
      cwdSpy.mockRestore();
    }
  });

  it("uses .next/standalone/server.js for local standalone layout", () => {
    const fakeCwd = "/tmp/9router-standalone-local";
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(fakeCwd);
    const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((filePath) => {
      return filePath === path.join(fakeCwd, ".next", "standalone", "server.js");
    });

    try {
      const resolved = resolveStandaloneServerPath(process.cwd());
      expect(resolved).toBe(path.join(fakeCwd, ".next", "standalone", "server.js"));
      expect(shouldSyncStandaloneAssets(resolved)).toBe(true);
    } finally {
      existsSpy.mockRestore();
      cwdSpy.mockRestore();
    }
  });
});

describe("go proxy wrapper health checks", () => {
  it("returns false when the health endpoint is unavailable", async () => {
    const ok = await waitForHttpHealth("http://127.0.0.1:65534/health", 150);
    expect(ok).toBe(false);
  });
});

describe("go proxy wrapper supervision startup", () => {
  it("fails fast when go-proxy/main.go is missing", () => {
    const fakeCwd = "/tmp/9router-missing-wrapper";
    const existsSyncSpy = vi.spyOn(process, "cwd").mockReturnValue(fakeCwd);

    try {
      expect(() =>
        spawnGoProxyWrapper(
          {
            host: "127.0.0.1",
            port: 8080,
          },
          {},
        ),
      ).toThrowError(`[Go Wrapper] Missing entrypoint: ${path.join(fakeCwd, "go-proxy", "main.go")}`);
    } finally {
      existsSyncSpy.mockRestore();
    }
  });
});

describe("go proxy wrapper supervision runtime", () => {
  it("stops app process when wrapper exits unexpectedly", () => {
    const wrapper = new EventEmitter();
    wrapper.once = wrapper.once.bind(wrapper);
    wrapper.removeListener = wrapper.removeListener.bind(wrapper);

    const kill = vi.fn();
    const appChild = { killed: false, kill };

    const onFatal = vi.fn();

    superviseGoProxyWrapper(wrapper, appChild, {
      isShuttingDown: () => false,
      onFatal,
    });

    wrapper.emit("exit", 2, null);

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not stop app process during intentional shutdown", () => {
    const wrapper = new EventEmitter();
    wrapper.once = wrapper.once.bind(wrapper);
    wrapper.removeListener = wrapper.removeListener.bind(wrapper);

    const kill = vi.fn();
    const appChild = { killed: false, kill };

    const onFatal = vi.fn();

    superviseGoProxyWrapper(wrapper, appChild, {
      isShuttingDown: () => true,
      onFatal,
    });

    wrapper.emit("exit", 0, "SIGTERM");

    expect(onFatal).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });
});
