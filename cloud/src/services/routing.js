// cloud/src/services/routing.js

import { getState } from "./state.js";
import * as log from "../utils/logger.js";

/**
 * Select credential for provider using round-robin/sticky logic
 * @param {Object} machineData - Machine data from D1
 * @param {string} provider - Provider name
 * @param {string} apiKey - Client API key (for sticky sessions)
 * @returns {Object} Selected credential
 */
export function selectCredential(machineData, provider, apiKey) {
  const settings = machineData.settings || {};

  // Warn if settings are missing
  if (!machineData.settings) {
    log.warn("ROUTING", `No settings found for ${provider}, using defaults (roundRobin=false, sticky=false)`);
  }

  // 1. Get all eligible credentials for provider
  const allProviders = Object.values(machineData.providers || {})
    .filter(p => p.provider === provider);
  const candidates = allProviders.filter(p => p.isActive);

  if (candidates.length === 0) {
    if (allProviders.length === 0) {
      throw new Error(`No credentials configured for provider: ${provider}`);
    } else {
      throw new Error(`All ${allProviders.length} credentials for ${provider} are inactive`);
    }
  }

  if (candidates.length === 1) {
    log.debug("ROUTING", `Single credential for ${provider}`);
    return candidates[0];
  }

  const state = getState();

  // 2. Check sticky session
  if (settings.sticky) {
    const sticky = state.stickyMap.get(apiKey);
    if (sticky) {
      if (sticky.expiresAt > Date.now()) {
        const found = candidates.find(c => c.id === sticky.connectionId);
        if (found) {
          log.debug("ROUTING", `Sticky session for ${provider}: ${found.id}`);
          return found;
        }
      } else {
        // Clean up expired session
        state.stickyMap.delete(apiKey);
        log.debug("ROUTING", `Removed expired sticky session for ${apiKey}`);
      }
    }
  }

  // 3. Apply round-robin
  if (settings.roundRobin) {
    const key = provider;
    const index = state.roundRobinIndexes.get(key) || 0;
    const selected = candidates[index % candidates.length];

    // Update index with overflow protection
    const nextIndex = (index + 1) % (candidates.length * 1000);
    state.roundRobinIndexes.set(key, nextIndex);

    log.debug("ROUTING", `Round-robin for ${provider}: ${selected.id} (index ${index})`);

    // Set sticky if enabled
    if (settings.sticky) {
      const expiresAt = Date.now() + (settings.stickyDuration * 1000);
      state.stickyMap.set(apiKey, {
        connectionId: selected.id,
        expiresAt
      });
      log.debug("ROUTING", `Set sticky session until ${new Date(expiresAt).toISOString()}`);
    }

    return selected;
  }

  // 4. Default: first available
  log.debug("ROUTING", `Default first credential for ${provider}: ${candidates[0].id}`);
  return candidates[0];
}
