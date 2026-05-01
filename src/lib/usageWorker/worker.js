// Usage Worker - Background process that runs the scheduler

import { UsageScheduler } from "./scheduler.js";

const channel = process.send ? process : null;
const scheduler = new UsageScheduler({
  onStatusChange: (status) => {
    channel?.send?.({
      type: "status_update",
      status,
    });
  },
});

function serializeError(error) {
  return {
    message: error?.message || String(error),
    stack: error?.stack || null,
  };
}

function sendStatusUpdate(extra = {}) {
  channel?.send?.({
    type: "status_update",
    status: {
      ...scheduler.getStatus(),
      ...extra,
    },
  });
}

process.on("unhandledRejection", (error) => {
  console.error("[UsageWorker] Unhandled rejection:", error);
  sendStatusUpdate({ workerError: serializeError(error).message });
});

process.on("uncaughtException", (error) => {
  console.error("[UsageWorker] Uncaught exception:", error);
  sendStatusUpdate({ workerError: serializeError(error).message });
});

// Handle IPC messages from parent process
process.on("message", async (message) => {
  const { command, requestId } = message || {};

  try {
    let result;

    switch (command) {
      case "start":
        await scheduler.start();
        result = { started: true };
        sendStatusUpdate();
        break;

      case "stop":
        scheduler.stop();
        result = { stopped: true };
        sendStatusUpdate();
        break;

      case "status":
        result = scheduler.getStatus();
        break;

      case "runNow":
        result = await scheduler.runBatch(message.reason || "manual");
        sendStatusUpdate();
        break;

      case "runAllNow":
        result = scheduler.requestFullRefresh(message.reason || "manual_full_refresh");
        sendStatusUpdate();
        break;

      default:
        throw new Error(`Unknown command: ${command}`);
    }

    channel?.send?.({
      type: "result",
      requestId,
      result,
    });
  } catch (error) {
    channel?.send?.({
      type: "error",
      requestId,
      error: error?.message || String(error),
    });
  }
});

async function boot() {
  try {
    await scheduler.loadSettings();
    sendStatusUpdate();
    channel?.send?.({ type: "ready" });
    scheduler.start()
      .then(() => sendStatusUpdate())
      .catch((error) => {
        console.error("[UsageWorker] Scheduler startup failed:", error);
        sendStatusUpdate({ workerError: serializeError(error).message });
      });
  } catch (error) {
    console.error("[UsageWorker] Scheduler settings load failed:", error);
    channel?.send?.({ type: "ready" });
    sendStatusUpdate({
      status: "error",
      workerError: serializeError(error).message,
    });
  }
}

boot();
