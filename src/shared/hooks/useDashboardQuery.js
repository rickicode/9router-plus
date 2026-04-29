"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const cache = new Map();
const DEFAULT_STALE_TIME_MS = 15_000;

function ensureEntry(key) {
  const cacheKey = String(key);
  if (!cache.has(cacheKey)) {
    cache.set(cacheKey, {
      data: undefined,
      error: null,
      promise: null,
      updatedAt: 0,
      subscribers: new Set(),
    });
  }
  return cache.get(cacheKey);
}

function notify(entry) {
  for (const subscriber of entry.subscribers) {
    subscriber({
      data: entry.data,
      error: entry.error,
      updatedAt: entry.updatedAt,
      isRefreshing: Boolean(entry.promise),
    });
  }
}

async function runFetch(entry, fetcher) {
  if (entry.promise) return entry.promise;

  entry.promise = (async () => {
    try {
      const data = await fetcher();
      entry.data = data;
      entry.error = null;
      entry.updatedAt = Date.now();
      return data;
    } catch (error) {
      entry.error = error;
      throw error;
    } finally {
      entry.promise = null;
      notify(entry);
    }
  })();

  notify(entry);
  return entry.promise;
}

export function primeDashboardQuery(key, data) {
  const entry = ensureEntry(key);
  entry.data = data;
  entry.error = null;
  entry.updatedAt = Date.now();
  notify(entry);
}

export function patchDashboardQuery(key, updater) {
  const entry = ensureEntry(key);
  const nextData = typeof updater === "function" ? updater(entry.data) : updater;
  entry.data = nextData;
  entry.error = null;
  entry.updatedAt = Date.now();
  notify(entry);
}

export function clearDashboardQuery(key) {
  cache.delete(String(key));
}

export function clearAllDashboardQueries() {
  cache.clear();
}

function isEntryStale(entry, staleTimeMs) {
  if (!entry) return true;
  if (entry.data === undefined) return true;
  if (!Number.isFinite(staleTimeMs) || staleTimeMs < 0) return true;
  return Date.now() - entry.updatedAt >= staleTimeMs;
}

export function useDashboardQuery(key, fetcher, options = {}) {
  const {
    enabled = true,
    initialData,
    staleTimeMs = DEFAULT_STALE_TIME_MS,
    revalidateOnMount = true,
  } = options;

  const cacheKey = useMemo(() => String(key), [key]);
  const initialEntry = ensureEntry(cacheKey);

  const [state, setState] = useState(() => ({
    data: initialEntry.data !== undefined ? initialEntry.data : initialData,
    error: initialEntry.error,
    updatedAt: initialEntry.updatedAt,
    isRefreshing: Boolean(initialEntry.promise),
  }));

  useEffect(() => {
    const entry = ensureEntry(cacheKey);
    const subscriber = (nextState) => {
      setState((current) => {
        if (
          current.data === nextState.data &&
          current.error === nextState.error &&
          current.updatedAt === nextState.updatedAt &&
          current.isRefreshing === nextState.isRefreshing
        ) {
          return current;
        }
        return nextState;
      });
    };

    entry.subscribers.add(subscriber);
    subscriber({
      data: entry.data,
      error: entry.error,
      updatedAt: entry.updatedAt,
      isRefreshing: Boolean(entry.promise),
    });

    return () => {
      entry.subscribers.delete(subscriber);
    };
  }, [cacheKey]);

  const refresh = useCallback(async () => {
    if (!enabled) return state.data;
    const entry = ensureEntry(cacheKey);
    return runFetch(entry, fetcher);
  }, [cacheKey, enabled, fetcher, state.data]);

  useEffect(() => {
    if (!enabled) return;
    const entry = ensureEntry(cacheKey);
    if (entry.data === undefined && !entry.promise) {
      void runFetch(entry, fetcher);
      return;
    }
    if (revalidateOnMount && isEntryStale(entry, staleTimeMs) && !entry.promise) {
      void runFetch(entry, fetcher);
    }
  }, [cacheKey, enabled, fetcher, revalidateOnMount, staleTimeMs]);

  const mutate = useCallback((updater) => {
    patchDashboardQuery(cacheKey, updater);
  }, [cacheKey]);

  return {
    data: state.data,
    error: state.error,
    isLoading: state.data === undefined && state.isRefreshing,
    isRefreshing: state.isRefreshing,
    refresh,
    mutate,
  };
}

export async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}
