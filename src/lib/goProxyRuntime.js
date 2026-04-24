import os from "node:os";
import path from "node:path";

export function createDefaultRuntimeState() {
  return {
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
  };
}

function isNonEmptyValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function normalizeGoProxyRuntimeCommandInput(runtime = {}) {
  return {
    ...runtime,
    ninerouterBaseUrl: runtime.ninerouterBaseUrl ?? runtime.baseUrl,
    internalResolveToken: runtime.internalResolveToken ?? runtime.resolveToken,
    internalReportToken: runtime.internalReportToken ?? runtime.reportToken,
    verifyRuntimeManager: runtime.verifyRuntimeManager,
    verification: runtime.verification,
  };
}

export function assertGoProxyRuntimeCommandReady(runtime = {}) {
  const normalizedRuntime = normalizeGoProxyRuntimeCommandInput(runtime);

  const requiredFields = [
    "binaryPath",
    "host",
    "port",
    "ninerouterBaseUrl",
    "internalResolveToken",
    "internalReportToken",
    "credentialsFile",
  ];

  const missing = requiredFields.filter((field) => !isNonEmptyValue(normalizedRuntime[field]));

  if (missing.length > 0) {
    throw new Error(
      `[Go Proxy Runtime] Missing required runtime command field(s): ${missing.join(", ")}`,
    );
  }
}

export function buildGoProxyCommand(runtime = {}) {
  const normalizedRuntime = normalizeGoProxyRuntimeCommandInput(runtime);

  assertGoProxyRuntimeCommandReady(normalizedRuntime);

  const args = [
    "--host",
    String(normalizedRuntime.host),
    "--port",
    String(normalizedRuntime.port),
    "--base-url",
    String(normalizedRuntime.ninerouterBaseUrl),
    "--resolve-token",
    String(normalizedRuntime.internalResolveToken),
    "--report-token",
    String(normalizedRuntime.internalReportToken),
    "--credentials-file",
    String(normalizedRuntime.credentialsFile),
  ];

  // HTTP timeout is set via environment variable, not CLI flag
  const env = {};
  if (isNonEmptyValue(normalizedRuntime.httpTimeoutSeconds)) {
    env.GO_PROXY_HTTP_TIMEOUT_SECONDS = String(normalizedRuntime.httpTimeoutSeconds);
  }

  return {
    file: String(normalizedRuntime.binaryPath),
    args,
    env,
  };
}

export function assertGoProxyRuntimeStartPreflightReady(runtime = {}) {
  assertGoProxyRuntimeCommandReady(runtime);
}

export function prepareGoProxyRuntimeStart(runtime = {}) {
  const normalizedRuntime = normalizeGoProxyRuntimeCommandInput(runtime);
  assertGoProxyRuntimeStartPreflightReady(normalizedRuntime);
  return {
    runtime: normalizedRuntime,
    command: buildGoProxyCommand(normalizedRuntime),
  };
}

function evaluateRuntimeManagerVerification(runtime = {}) {
  if (typeof runtime.verifyRuntimeManager === "function") {
    return runtime.verifyRuntimeManager(runtime);
  }

  if (runtime.verification && typeof runtime.verification === "object") {
    return runtime.verification;
  }

  return { ok: true };
}

function getRuntimeManagerVerificationError(verificationResult) {
  if (!verificationResult || verificationResult.ok !== false) return null;
  return verificationResult.error || "runtime-manager verification failed";
}

function applyRuntimeVerificationFailure(snapshot, errorMessage) {
  return runtimeRegistry.reset({
    ...snapshot,
    lastError: errorMessage,
  });
}

function assertRuntimeManagerVerified(runtime = {}, rollbackSnapshot) {
  const verificationResult = evaluateRuntimeManagerVerification(runtime);
  const errorMessage = getRuntimeManagerVerificationError(verificationResult);

  if (!errorMessage) return verificationResult;

  applyRuntimeVerificationFailure(rollbackSnapshot, errorMessage);
  throw new Error(`[Go Proxy Runtime] Runtime manager verification failed: ${errorMessage}`);
}

export function createRuntimeStateRegistry(initialState = {}) {
  let snapshot = {
    ...createDefaultRuntimeState(),
    ...initialState,
  };

  return {
    getSnapshot() {
      return { ...snapshot };
    },
    setState(patch = {}) {
      snapshot = {
        ...snapshot,
        ...patch,
      };
      return { ...snapshot };
    },
    reset(nextState = {}) {
      snapshot = {
        ...createDefaultRuntimeState(),
        ...nextState,
      };
      return { ...snapshot };
    },
  };
}

const runtimeRegistry = createRuntimeStateRegistry();

export function getGoProxyRuntimeStatus() {
  return runtimeRegistry.getSnapshot();
}

export function setGoProxyRuntimeState(patch = {}) {
  return runtimeRegistry.setState(patch);
}

export function resetGoProxyRuntimeState(nextState = {}) {
  return runtimeRegistry.reset(nextState);
}

export async function startGoProxyRuntime(overrides = {}) {
  const currentState = runtimeRegistry.getSnapshot();
  const nextState = {
    ...currentState,
    ...overrides,
    enabled: true,
    running: true,
    status: "running",
    startedAt: new Date().toISOString(),
    lastError: null,
  };

  assertGoProxyRuntimeStartPreflightReady(nextState);
  const runtime = runtimeRegistry.setState(nextState);
  assertRuntimeManagerVerified(runtime, currentState);
  return runtimeRegistry.getSnapshot();
}

export async function stopGoProxyRuntime(overrides = {}) {
  const currentState = runtimeRegistry.getSnapshot();
  return runtimeRegistry.setState({
    ...currentState,
    enabled: false,
    running: false,
    status: "stopped",
    pid: null,
    startedAt: null,
    lastExitCode: 0,
    ...overrides,
  });
}

export async function restartGoProxyRuntime(overrides = {}) {
  const currentState = runtimeRegistry.getSnapshot();
  const nextState = {
    ...currentState,
    ...overrides,
  };

  assertGoProxyRuntimeStartPreflightReady(nextState);
  await stopGoProxyRuntime();

  try {
    return await startGoProxyRuntime({
      ...nextState,
      startedAt: undefined,
    });
  } catch (error) {
    applyRuntimeVerificationFailure(currentState, error.message.replace("[Go Proxy Runtime] Runtime manager verification failed: ", ""));
    throw error;
  }
}

export function setGoProxyRuntimePort(port) {
  return runtimeRegistry.setState({ port });
}

export { runtimeRegistry };
