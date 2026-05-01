let initialized = false;

export async function ensureAppInitialized() {
  if (!initialized) {
    try {
      const { default: initializeApp } = await import("@/shared/services/initializeApp");
      await initializeApp();
      initialized = true;
    } catch (error) {
      console.error("[ServerInit] Error initializing app:", error);
    }
  }
  return initialized;
}

// Auto-initialize at runtime only, not during next build
if (process.env.NEXT_PHASE !== "phase-production-build") {
  ensureAppInitialized().catch(console.log);
}

export default ensureAppInitialized;
