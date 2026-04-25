import { loadSingletonFromSqlite, upsertSingleton } from "@/lib/sqliteHelpers.js";

function loadTunnelState() {
  return loadSingletonFromSqlite("tunnelState") || {};
}

function saveTunnelState(next) {
  upsertSingleton("tunnelState", next);
}

export function loadState() {
  return loadTunnelState().state || null;
}

export function saveState(state) {
  saveTunnelState({ ...loadTunnelState(), state });
}

export function clearState() {
  const next = { ...loadTunnelState() };
  delete next.state;
  saveTunnelState(next);
}

// Cloudflare-specific PID
export function savePid(pid) {
  saveTunnelState({ ...loadTunnelState(), cloudflaredPid: Number(pid) });
}

export function loadPid() {
  return loadTunnelState().cloudflaredPid ?? null;
}

export function clearPid() {
  const next = { ...loadTunnelState() };
  delete next.cloudflaredPid;
  saveTunnelState(next);
}

// Tailscale-specific PID
export function saveTailscalePid(pid) {
  saveTunnelState({ ...loadTunnelState(), tailscalePid: Number(pid) });
}

export function loadTailscalePid() {
  return loadTunnelState().tailscalePid ?? null;
}

export function clearTailscalePid() {
  const next = { ...loadTunnelState() };
  delete next.tailscalePid;
  saveTunnelState(next);
}

const SHORT_ID_LENGTH = 6;
const SHORT_ID_CHARS = "abcdefghijklmnpqrstuvwxyz23456789";

export function generateShortId() {
  let result = "";
  for (let i = 0; i < SHORT_ID_LENGTH; i++) {
    result += SHORT_ID_CHARS.charAt(Math.floor(Math.random() * SHORT_ID_CHARS.length));
  }
  return result;
}
