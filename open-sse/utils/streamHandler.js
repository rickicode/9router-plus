// Stream handler with disconnect detection - shared for all providers
import { getStreamIdleTimeoutMs } from "./abort.js";

// Get HH:MM:SS timestamp
function getTimeString() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Create stream controller with abort and disconnect detection
 * @param {object} options
 * @param {function} options.onDisconnect - Callback when client disconnects
 * @param {object} options.log - Logger instance
 * @param {string} options.provider - Provider name
 * @param {string} options.model - Model name
 */
export function createStreamController({ onDisconnect, onError, log, provider, model } = {}) {
  const abortController = new AbortController();
  const startTime = Date.now();
  let disconnected = false;
  let abortTimeout = null;

  const logStream = (status) => {
    const duration = Date.now() - startTime;
    const p = provider?.toUpperCase() || "UNKNOWN";
    console.log(`[${getTimeString()}] 🌊 [STREAM] ${p} | ${model || "unknown"} | ${duration}ms | ${status}`);
  };

  return {
    signal: abortController.signal,
    startTime,

    isConnected: () => !disconnected,

    // Call when client disconnects
    handleDisconnect: (reason = "client_closed") => {
      if (disconnected) return;
      disconnected = true;

      logStream(`disconnect: ${reason}`);

      // Delay abort to allow cleanup
      abortTimeout = setTimeout(() => {
        abortController.abort();
      }, 500);

      onDisconnect?.({ reason, duration: Date.now() - startTime });
    },

    // Call when stream completes normally
    handleComplete: () => {
      if (disconnected) return;
      disconnected = true;

      logStream("complete");

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }
    },

    // Call on error
    handleError: (error) => {
      if (disconnected) return;
      disconnected = true;

      if (abortTimeout) {
        clearTimeout(abortTimeout);
        abortTimeout = null;
      }

      if (error.name === "AbortError") {
        logStream("aborted");
        if (error.code === "UPSTREAM_TIMEOUT" || error.code === "STREAM_IDLE_TIMEOUT") {
          onError?.(error);
        }
        return;
      }

      logStream(`error: ${error.message}`);
      onError?.(error);
    },

    abort: () => abortController.abort()
  };
}

/**
 * Create transform stream with disconnect detection
 * Wraps existing transform stream and adds abort capability
 */
export function createDisconnectAwareStream(transformStream, streamController) {
  const reader = transformStream.readable.getReader();
  const writer = transformStream.writable.getWriter();
  const idleTimeoutMs = getStreamIdleTimeoutMs();
  let idleTimer = null;

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const refreshIdleTimer = (controller) => {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      const error = new Error(`stream idle timeout after ${idleTimeoutMs}ms`);
      error.name = "AbortError";
      error.code = "STREAM_IDLE_TIMEOUT";
      streamController.handleError(error);
      reader.cancel(error).catch(() => {});
      writer.abort(error).catch(() => {});
      try {
        controller.error(error);
      } catch {}
    }, idleTimeoutMs);
  };

  return new ReadableStream({
    async pull(controller) {
      if (!streamController.isConnected()) {
        clearIdleTimer();
        controller.close();
        return;
      }

      try {
        refreshIdleTimer(controller);
        const { done, value } = await reader.read();
        clearIdleTimer();
        if (done) {
          streamController.handleComplete();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        clearIdleTimer();
        streamController.handleError(error);
        // Cleanup reader/writer to avoid orphaned streams
        reader.cancel().catch(() => {});
        writer.abort().catch(() => {});
        controller.error(error);
      }
    },

    cancel(reason) {
      clearIdleTimer();
      streamController.handleDisconnect(reason || "cancelled");
      reader.cancel();
      writer.abort();
    }
  });
}

/**
 * Pipe provider response through transform with disconnect detection
 * @param {Response} providerResponse - Response from provider
 * @param {TransformStream} transformStream - Transform stream for SSE
 * @param {object} streamController - Stream controller from createStreamController
 */
export function pipeWithDisconnect(providerResponse, transformStream, streamController) {
  const transformedBody = providerResponse.body.pipeThrough(transformStream);
  return createDisconnectAwareStream(
    { readable: transformedBody, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } },
    streamController
  );
}

