## 2026-04-27T15:19:43Z Session bootstrap
- Plan scope is Morph as a special integration, not a generic provider.
- All five Morph capabilities must remain raw transport proxies with no translation or normalization.
- Live direct-vs-proxy comparison is required, but temporary API keys must stay out of tracked files and evidence must redact auth values.

## 2026-04-27T22:26:00Z Morph settings contract
- Added local-only `settings.morph` contract with exactly `baseUrl`, `apiKeys`, and `roundRobinEnabled` in `src/lib/localDb.js`.
- Canonical defaults are `https://api.morphllm.com`, empty key list, and round robin disabled.
- API keys are trimmed, empty entries removed, exact duplicates deduped in first-seen order, and non-string values ignored during normalization.
- Invalid Morph base URLs now fail deterministically with `Morph base URL must be a valid absolute http(s) URL`; the settings PATCH route converts that specific normalization error into HTTP 400.
- Reusable `MORPH_CAPABILITY_UPSTREAMS` constant documents the raw proxy mapping: apply/warpgrep -> POST /v1/chat/completions, compact -> POST /v1/compact, embeddings -> POST /v1/embeddings, rerank -> POST /v1/rerank.

## 2026-04-27T15:32:58Z Morph key selection helper
- Added `src/lib/morph/keySelection.js` as a Morph-only in-memory rotation helper; no provider-generic abstraction or persisted cursor state was introduced.
- `getMorphKeyOrder()` now guarantees deterministic behavior: zero keys -> empty order, one key -> stable index 0, round robin off -> always start at index 0, round robin on -> stable cyclic wraparound per `rotationKey`.
- `executeWithMorphKeyFailover()` retries the same request with the next key only for eligible upstream failures: HTTP 401, 429, 5xx, and thrown network/timeout errors after dispatch starts.
- Pre-dispatch request construction errors remain immediate failures by requiring `dispatchStarted === true` before thrown errors become retryable.

## 2026-04-27T15:33:49Z Morph nav shell
- Added `Morph` as a top-level sidebar item in `src/shared/components/Sidebar.js` with the existing `pathname.startsWith(href)` active-state behavior unchanged.
- Created `src/app/(dashboard)/dashboard/morph/page.js` as a dashboard-layout route shell using shared `Card` styling and copy that frames Morph as a raw proxy-only bundle, separate from normal providers and `/api/v1` translation flows.
- Documented all five capability endpoints directly on the page shell: `/api/morph/apply`, `/api/morph/compact`, `/api/morph/embeddings`, `/api/morph/rerank`, and `/api/morph/warpgrep`.

## 2026-04-27T15:39:31Z Morph route QA re-check
- Re-verified `src/app/(dashboard)/dashboard/morph/page.js` follows the same route-file convention as other dashboard pages (`settings`, `opencode`, `mitm`): a `page.js` file directly under `src/app/(dashboard)/dashboard/<slug>/`.
- Confirmed repo-local route registration without relying on the default dev port: `.next/server/app-paths-manifest.json` contains `/(dashboard)/dashboard/morph/page` after `npm run build`.
- Verified hands-on route resolution by running this repo on an alternate port with `PORT=3011 HOSTNAME=127.0.0.1 npm start` and fetching `http://127.0.0.1:3011/dashboard/morph`, which returned HTTP 200.

## 2026-04-27T22:50:00Z Morph settings route merge behavior
- `GET /api/settings` already returned `morph` correctly because `src/app/api/settings/route.js` spreads `safeSettings` and `getSettings()` already normalizes defaults through `mergeSettingsWithDefaults()`.
- `PATCH /api/settings` needed an explicit nested merge for `body.morph` inside `src/app/api/settings/route.js` because `updateSettings()` only deep-merges `quotaScheduler`; without the route-level merge, partial Morph patches reset omitted Morph subfields to defaults.
- Added unit coverage in `tests/unit/morph-settings-route.test.js` for defaults, full updates, partial updates, invalid base URL 400 handling, and preservation of unrelated settings during Morph-only PATCH requests.

## 2026-04-27T22:49:00Z Morph namespace protection and dispatch helper
- Protected the raw Morph namespace by adding `/api/morph/:path*` to `src/proxy.js` alongside the other dashboard API matchers.
- Added `src/app/api/morph/_dispatch.js` as a Morph-only shared helper that resolves upstream targets from `MORPH_CAPABILITY_UPSTREAMS` and uses `executeWithMorphKeyFailover()` for API-key rotation and retries.
- The shared dispatcher intentionally stays translator-free: it forwards the untouched JSON body with `Authorization: Bearer <key>` and `Content-Type: application/json`, then returns the upstream response stream/status unchanged.
- Added `tests/unit/morph-namespace.test.js` as a source-level guard against accidentally importing `/api/v1` translator handlers or bypassing the canonical Morph capability map/failover helper.

## 2026-04-27T22:53:00Z Morph settings dashboard UI
- Built `src/app/(dashboard)/dashboard/morph/MorphPageClient.js` as a dedicated client component instead of keeping Morph UI inline in `page.js`, matching the dashboard split between route shell and interactive client surface.
- Reused the existing settings-page load/save/feedback pattern: fetch on mount, keep `saved*` and editable state copies, reset feedback before save, and show success/error banners in-card.
- The Morph settings editor intentionally stays Morph-specific: base URL, ordered API keys, round-robin toggle, and fixed route inventory only; it does not reuse provider-management forms or model selection UI.
- Source-inspection coverage in `tests/unit/morph-settings-ui.test.js` is enough for this task because the required assertions are about literal UI contract presence in source, not browser interaction behavior.

## 2026-04-27T23:03:00Z Morph embeddings/rerank/warpgrep routes
- Added `src/app/api/morph/embeddings/route.js`, `src/app/api/morph/rerank/route.js`, and `src/app/api/morph/warpgrep/route.js` as minimal raw proxy handlers: load `settings.morph`, return HTTP 503 when `baseUrl` is missing or `apiKeys` is empty, otherwise call `dispatchMorphCapability({ capability, req, morphSettings })` and return that `Response` directly.
- Kept the new routes translator-free and `/api/v1`-free, matching the Morph contract that capability routes are transport pass-throughs rather than format adapters.
- `warpgrep` stays especially strict: no local tool execution, no tool-call payload rewriting, and no route-level adaptation logic; the built-in Morph upstream protocol remains untouched.
- Added `tests/unit/morph-erw-routes.test.js` using the same source-inspection-plus-mocked-behavior pattern as `tests/unit/morph-apply-compact.test.js` to guard imports, capability strings, raw pass-through behavior, and the 503 unconfigured response.

## 2026-04-27T16:01:33Z Morph apply/compact raw routes
- Added `src/app/api/morph/apply/route.js` and `src/app/api/morph/compact/route.js` as minimal raw pass-through handlers: they read `settings.morph`, reject missing `baseUrl` or empty `apiKeys` with HTTP 503, and otherwise return `dispatchMorphCapability()` directly.
- Added `tests/unit/morph-apply-compact.test.js` to lock the contract at both source and behavior level so these routes cannot drift toward `/api/v1` translator imports or response remapping.

## 2026-04-27T23:12:00Z Morph regression and HTTP coverage
- Added `tests/unit/morph-regression.test.js` to lock Morph raw-proxy isolation at source level across all five route modules plus `src/app/api/morph/_dispatch.js`, including the `/api/morph` matcher guard, Morph-only key-selection isolation, and an exact non-regression snapshot for `src/app/api/v1/embeddings/route.js`.
- Added `tests/unit/morph-dispatch-http.test.js` to verify capability-level HTTP behavior inside `dispatchMorphCapability()`: apply/warpgrep -> `/v1/chat/completions`, compact -> `/v1/compact`, embeddings -> `/v1/embeddings`, rerank -> `/v1/rerank`, while preserving the raw JSON body and Bearer auth header.
- In this environment `typescript-language-server` is unavailable, so `npm run build` serves as the compile check; the build passed and still registered all five `/api/morph/*` routes.
- Live direct-vs-proxy comparison must remain env-only; this run skipped it because `MORPH_API_KEY_TEMP` was unset, and the evidence file documents the skip without writing any secret material.
- F2 console.log re-check: `src/app/api/settings/route.js` has `console.log` at lines 64, 129, and 160 in the working tree, but `git show HEAD:src/app/api/settings/route.js` contains none; Morph-specific paths `src/app/api/morph/`, `src/lib/morph/`, and `src/app/(dashboard)/dashboard/morph/` also contain no `console.log` matches.
