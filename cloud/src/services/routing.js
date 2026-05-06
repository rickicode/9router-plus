// cloud/src/services/routing.js

import { getState } from "./state.js";
import * as log from "../utils/logger.js";
import { isAccountUnavailable } from "open-sse/services/accountFallback.js";
import { updateRuntimeProviderState } from "./storage.js";

function getStickySelection(candidates, apiKey, nowIso) {
  if (!apiKey) return null;

  const stickyCandidate = candidates.find((candidate) => {
    if (!candidate.stickyKeyHash || !candidate.stickyUntil) {
      return false;
    }
    return candidate.stickyKeyHash === apiKey && new Date(candidate.stickyUntil).getTime() > Date.now();
  });

  if (!stickyCandidate) {
    return null;
  }

  log.debug("ROUTING", `Sticky session hit for ${stickyCandidate.provider}: ${stickyCandidate.id}`);
  return stickyCandidate;
}

async function setStickySelection(runtimeConfig, selected, apiKey, stickyDurationSeconds, env) {
  if (!apiKey || !selected?.id) {
    return;
  }

  const stickyUntil = new Date(Date.now() + (stickyDurationSeconds * 1000)).toISOString();
  await updateRuntimeProviderState(runtimeConfig.runtimeId || "shared", selected.id, (conn) => {
    conn.stickyKeyHash = apiKey;
    conn.stickyUntil = stickyUntil;
  }, env, { runtimeConfig });
}

/**
 * Select credential for provider using round-robin/sticky logic.
 * @param {Object} runtimeConfig - Shared runtime config/state snapshot
 * @param {string} provider - Provider name
 * @param {string} apiKey - Client API key (for sticky sessions)
 * @returns {Object} Selected credential
 */
export async function selectCredential(runtimeConfig, provider, apiKey, env) {
  const settings = runtimeConfig.settings || {};
  const routing = settings.routing || {};
  const providerOverride = routing.providerStrategies?.[provider] || settings.providerStrategies?.[provider] || {};
  const strategy = providerOverride.strategy
    || providerOverride.fallbackStrategy
    || runtimeConfig.strategy
    || routing.strategy
    || (settings.roundRobin ? "round-robin" : "fill-first");
  const stickyEnabled = routing.sticky?.enabled ?? settings.sticky;
  const stickyDurationSeconds = routing.sticky?.durationSeconds ?? settings.stickyDuration ?? 300;

  // Warn if settings are missing
  if (!runtimeConfig.settings) {
    log.warn("ROUTING", `No settings found for ${provider}, using defaults (roundRobin=false, sticky=false)`);
  }

  // Mirror local 9router behavior: initial candidate selection must honor
  // canonical account availability, not just the isActive flag.
  const allProviders = Object.values(runtimeConfig.providers || {})
    .filter((p) => p.provider === provider);
  const activeCandidates = allProviders.filter((p) => p.isActive);
  const candidates = activeCandidates.filter((p) => !isAccountUnavailable(p));

  if (candidates.length === 0) {
    if (allProviders.length === 0) {
      throw new Error(`No credentials configured for provider: ${provider}`);
    }
    if (activeCandidates.length === 0) {
      throw new Error(`All ${allProviders.length} credentials for ${provider} are inactive`);
    }
    throw new Error(`No available credentials for provider: ${provider}`);
  }

  if (candidates.length === 1) {
    log.debug("ROUTING", `Single available credential for ${provider}`);
    return candidates[0];
  }

  const state = getState();
  const nowIso = new Date().toISOString();

  // Sticky affinity is persisted in D1 so it survives isolate churn.
  if (stickyEnabled) {
    const stickyCandidate = getStickySelection(candidates, apiKey, nowIso);
    if (stickyCandidate) {
      return stickyCandidate;
    }
  }

  if (strategy === "round-robin") {
    const key = provider;
    const index = state.roundRobinIndexes.get(key) || 0;
    const selected = candidates[index % candidates.length];

    const nextIndex = (index + 1) % (candidates.length * 1000);
    state.roundRobinIndexes.set(key, nextIndex);

    log.debug("ROUTING", `Round-robin for ${provider}: ${selected.id} (index ${index})`);

    if (stickyEnabled) {
      await setStickySelection(runtimeConfig, selected, apiKey, stickyDurationSeconds, env);
    }

    return selected;
  }

  log.debug("ROUTING", `Default first credential for ${provider}: ${candidates[0].id}`);
  if (stickyEnabled) {
    await setStickySelection(runtimeConfig, candidates[0], apiKey, stickyDurationSeconds, env);
  }
  return candidates[0];
}
