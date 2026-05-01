# Plan: Cloud Worker communication and runtime credential sync improvements

## Context

- 9Router currently communicates with Cloud Worker through several control-plane endpoints: registration, health/status, runtime refresh, usage polling, and usage event sync.
- The current runtime sync path is structurally good because 9Router publishes runtime artifacts to R2 and then asks the worker to refresh from R2, instead of pushing large payloads directly to the worker.
- Confirmed runtime loading behavior:
  - when `R2_RUNTIME` is available in the worker, the worker reads only `runtime/credentials.full.json` and `runtime/runtime.config.json`, then merges them in `cloud/src/services/runtimeConfig.js`
  - the older public-URL path reads `runtime.json` and optionally overlays `eligible.json`
- There are still efficiency issues in the communication model:
  - usage is fetched through two separate channels (`/worker/usage` polling and `/admin/usage/events` cursor sync)
  - worker status often requires multiple requests (`/admin/health` plus `/admin/status.json`)
  - periodic sync can republish artifacts and trigger worker refresh even when runtime data has not meaningfully changed
- Confirmed requirement: `credentials.full.json` should contain only accounts that are both active and currently `eligible`, but for those accounts the credential payload must be complete/full so the worker receives all required secrets/tokens/metadata.
- Credential publishing currently appears narrower than the requested target only if any required credential fields are dropped during artifact generation; the main validation point is `buildFullCredentialsArtifact(...)` in `src/lib/r2RuntimeArtifacts.js`.
- There is also a contract mismatch to resolve in the usage-event channel: worker `GET /admin/usage/events` requires `machineId`, but `fetchWorkerUsageEvents(...)` currently sends only `cursor` and `limit`.

## Approach

- Keep the R2-based runtime distribution model, but reduce unnecessary worker round-trips and duplicate observability traffic.
- Review and tighten the artifact generation path so the credential payload uploaded to R2 fully includes the intended eligible account credential set with all required fields for worker runtime use.
- Consolidate the worker communication plan around clearer responsibilities:
  - registration/refresh for control-plane
  - one primary usage synchronization path for analytics/state sync
  - optional lightweight status/health access for UI
- Add change-detection planning so runtime publishes and worker refreshes only happen when artifacts actually change.

## Files to modify

- `src/lib/r2RuntimeArtifacts.js`
- `src/lib/r2BackupClient.js`
- `src/lib/cloudSync.js`
- `src/lib/cloudWorkerClient.js`
- `src/lib/cloudUsageSync.js`
- `src/shared/services/cloudUsagePoller.js`
- `src/shared/services/cloudSyncScheduler.js`
- `src/app/api/cloud-urls/[id]/status/route.js`
- `src/app/api/r2/route.js`
- `cloud/src/handlers/admin.js`
- `cloud/src/handlers/usage.js`
- possibly worker runtime-loading code under `cloud/src/services/*` once traced in the next pass

## Reuse

- Worker runtime loading should be reused, with contract adjustments only where needed:
  - `createRuntimeConfigLoader(...).load(...)` in `cloud/src/services/runtimeConfig.js`
  - `getRuntimeConfig(...)` and `invalidateRuntimeConfig(...)` in `cloud/src/services/storage.js`
- Runtime artifact builders already exist and should be reused rather than replaced:
  - `buildRuntimeArtifact(...)` in `src/lib/r2RuntimeArtifacts.js`
  - `buildEligibleRuntimeArtifact(...)` in `src/lib/r2RuntimeArtifacts.js`
  - `buildFullCredentialsArtifact(...)` in `src/lib/r2RuntimeArtifacts.js`
  - `buildRuntimeConfigArtifact(...)` in `src/lib/r2RuntimeArtifacts.js`
- Existing publish flow should remain the backbone:
  - `publishRuntimeArtifactsFromSettings(...)` in `src/lib/r2BackupClient.js`
  - `ensureWorkerRuntimeArtifacts(...)` in `src/lib/cloudSync.js`
- Existing worker client methods should be reused and possibly expanded instead of reworked from scratch:
  - `registerWithWorker(...)` in `src/lib/cloudWorkerClient.js`
  - `refreshWorkerRuntime(...)` in `src/lib/cloudWorkerClient.js`
  - `fetchWorkerStatus(...)` in `src/lib/cloudWorkerClient.js`
  - `fetchWorkerUsageEvents(...)` in `src/lib/cloudWorkerClient.js`
- Existing worker admin/status handlers should be reused as the status contract:
  - `handleAdminStatusJson(...)` in `cloud/src/handlers/admin.js`
  - `handleAdminRuntimeRefresh(...)` in `cloud/src/handlers/admin.js`
  - `handleUsage(...)` and `handleAdminUsageEvents(...)` in `cloud/src/handlers/usage.js`

## Steps

- [x] Trace the worker runtime artifact loading path to confirm exactly which R2 artifacts are consumed by the worker and how `credentials.full.json` is used versus `runtime.json` / `eligible.json` / `runtime.config.json`.
- [x] Verify the intended credential scope by comparing artifact builders with worker runtime readers, especially whether “full credentials” should include all active accounts or only eligible accounts with complete secrets/tokens.
- [ ] Design a slimmer communication model for 9Router -> Worker status and usage sync, reducing duplicated polling and redundant calls while preserving dashboard visibility and analytics capture.
- [ ] Resolve the current usage-event API contract mismatch (`machineId` requirement on worker vs client not sending it) and decide whether the event channel stays as the primary sync path.
- [ ] Plan change-detection for runtime publish/sync so uploads and worker refreshes are skipped when artifacts are unchanged.
- [ ] Define concrete code changes for artifact generation, worker runtime refresh metadata, status contract, and usage synchronization path.
- [ ] Define verification scenarios for worker registration, runtime refresh, credential completeness in R2, usage sync correctness, and no-regression routing behavior.

## Verification

- Confirm R2 publishes all expected runtime artifacts successfully, especially `runtime/credentials.full.json`.
- Inspect the generated credentials artifact and verify it contains only active + `eligible` accounts, and that each included account keeps full credential fields needed by the worker (`accessToken`, `refreshToken`, `apiKey`, `expiresAt`, `providerSpecificData`, and related metadata where applicable).
- Trigger cloud sync and verify worker refresh succeeds without redundant failures.
- Verify worker status/dashboard still works and returns expected provider/account counts.
- Verify usage data still appears correctly after communication changes, with no duplicate ingestion.
- Verify chat/embedding requests through the worker still route correctly using refreshed credentials.
