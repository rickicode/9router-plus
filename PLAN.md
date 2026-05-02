# Plan: Cloud Worker D1 runtime sync with R2 backup

## Context

- The current cloud routing failures are best explained by runtime-state drift and cloud-side account-state poisoning, not by missing credential payloads in the published runtime artifact.
- Confirmed behavior from prior tracing:
  - `runtime/credentials.full.json` contains only active + `eligible` accounts, but included accounts retain full credential payloads needed by the worker.
  - the worker currently reads runtime data from R2 artifacts and then mutates in-memory/cloud runtime state during live requests.
- The user has chosen a new control-plane model:
  - sync remains one-way from local `9router` to each registered Cloud Worker
  - Cloud Worker should use D1 as the primary source of truth for runtime credentials/configuration and mutable routing state
  - R2 must remain enabled for backup/export only on the `9router` side; the worker should not own or require R2 bindings
- The user also wants cloud observability to improve:
  - access to worker logs/admin inspection should be available through shared-secret-protected endpoints
  - admin/status/log access should authenticate with the existing shared secret specifically, not a separate login mechanism
  - console-visible diagnostics should make it easier to inspect live worker behavior after deploys
- This change is user-visible because the deployed worker must stop reporting false Codex exhaustion and must expose enough admin/log information to distinguish real provider failures from cloud routing/state bugs.

## Approach

- Move cloud runtime reads for chat/embeddings/routing from R2-backed runtime artifacts to D1-backed runtime tables.
- Keep sync one-way: local `9router` pushes credentials, API keys, aliases, combos, and settings to each worker; workers do not pull credentials from clients or from local state.
- Keep R2 as a `9router`-owned backup/export layer only:
  - publish credential/runtime snapshots to R2 from `9router` for backup and restore
  - do not bind worker runtime decisions or worker deployment requirements to R2
- Preserve cloud-owned mutable state separately from publisher-owned credential/config state:
  - publisher-owned: tokens, metadata, `isActive`, canonical config/settings
  - cloud-owned runtime state: `nextRetryAt`, `backoffLevel`, `lastUsedAt`, sticky/session hints, temporary health/quota/auth transitions caused by live traffic
- Add shared-secret-protected admin/log endpoints so the user can inspect worker status and recent console/runtime events directly, using the existing shared secret as the login/auth mechanism.

## Files to modify

- `src/lib/cloudSync.js`
- `src/lib/cloudWorkerClient.js`
- `src/lib/r2BackupClient.js`
- `src/lib/r2RuntimeArtifacts.js`
- `src/shared/services/cloudSyncScheduler.js`
- `src/app/api/cloud-urls/[id]/status/route.js`
- `cloud/src/handlers/sync.js`
- `cloud/src/handlers/admin.js`
- `cloud/src/handlers/chat.js`
- `cloud/src/handlers/embeddings.js`
- `cloud/src/services/storage.js`
- `cloud/src/services/routing.js`
- `cloud/wrangler.toml`
- D1 schema/migration files under `cloud/` if present

## Reuse

- Reuse the existing runtime artifact builders for the `9router`-owned R2 backup path instead of deleting them:
  - `buildFullCredentialsArtifact(...)` in `src/lib/r2RuntimeArtifacts.js`
  - `buildRuntimeConfigArtifact(...)` in `src/lib/r2RuntimeArtifacts.js`
  - `publishRuntimeArtifactsFromSettings(...)` in `src/lib/r2BackupClient.js`
- Reuse the existing cloud sync/client flow as the control-plane backbone, but change the payload target from “refresh from R2” to “upsert into D1”:
  - `ensureWorkerRuntimeArtifacts(...)` in `src/lib/cloudSync.js`
  - worker registration/sync helpers in `src/lib/cloudWorkerClient.js`
- Reuse cloud request handlers and routing logic, but retarget their reads/writes to D1-backed storage helpers:
  - `handleSingleModelChat(...)` in `cloud/src/handlers/chat.js`
  - `handleEmbeddings(...)` in `cloud/src/handlers/embeddings.js`
  - `selectCredential(...)` in `cloud/src/services/routing.js`
- Reuse existing shared-secret admin patterns where possible in worker handlers:
  - `handleAdminStatusJson(...)` in `cloud/src/handlers/admin.js`
  - existing auth checks in admin/sync routes

## Steps

- [x] Confirm the existing R2 artifact format and worker runtime loader behavior well enough to retire “bad credential artifact shape” as the primary hypothesis.
- [x] Confirm the new architecture decision: one-way `9router -> cloud` sync, D1 as primary runtime store, R2 retained as backup.
- [x] Design the D1 schema split between publisher-owned credential/config records and cloud-owned mutable runtime state.
- [x] Define the sync contract from `9router` to worker: credential/config upsert, deletion/pruning behavior, and when runtime-owned fields are preserved versus overwritten.
- [x] Define how cloud chat/embeddings/routing/storage will read from D1, update cooldown/backoff/runtime health in D1, and use only short-lived memory caching if still needed.
- [x] Define the retained R2 backup flow on the `9router` side only, without worker R2 bindings or worker-side restore/bootstrap endpoints.
- [x] Add shared-secret-protected admin/log access for status inspection and recent worker logs/diagnostics, authenticated with the existing shared secret, so live failures can be investigated without guessing.
- [ ] Define verification for one-way sync, D1-backed routing correctness, `9router`-owned R2 backup integrity, and admin/log visibility.

## Verification

- Trigger a one-way sync from local `9router` to a registered worker and verify credentials/config land in D1 correctly.
- Verify cloud chat/embeddings requests read from D1 and no longer depend on worker R2 runtime artifacts for live routing decisions.
- Verify runtime mutations from live requests update only the intended cloud-owned fields in D1.
- Verify R2 backup artifacts are still published by `9router` and remain outside worker deployment requirements.
- Verify shared-secret-protected admin/status and log inspection endpoints authenticate with the existing shared secret and return useful live worker diagnostics.
- Re-run direct live worker requests for Codex-backed routes and confirm false `All accounts unavailable after max retries` no longer appears unless supported by real runtime evidence.
