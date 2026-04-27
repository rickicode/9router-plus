# Morph Raw Proxy Bundle For 9Router Plus

## TL;DR
> **Summary**: Add a top-level Morph dashboard destination plus a tightly scoped raw proxy bundle for Morph's five documented capabilities: `apply`, `compact`, `embedding`, `rerank`, and `warpgrep`. Treat every Morph API as an Nginx-like upstream proxy only: no translation, no normalization, no payload reshaping, and no generic provider-framework rewrite.
> **Deliverables**:
> - Top-level `Morph` dashboard nav item and page
> - Persisted Morph settings with base URL, ordered API key list, and round-robin toggle
> - Dedicated Morph API namespace with five raw pass-through capability routes
> - Runtime key rotation/failover helper used only by Morph routes
> - Vitest coverage and HTTP-level QA evidence per capability
> **Effort**: Large
> **Parallel**: YES - 3 waves
> **Critical Path**: 1 -> 2 -> 5 -> 7 -> 9 -> F1-F4

## Context
### Original Request
User wants a dedicated Morph menu in `9router-plus`. Morph must not be treated like a standard AI chat provider. The integration should act as a proxy only, with no response translation/parsing layer. User corrected the earlier assumption that Morph only needs `apply`; official Morph docs expose five capability surfaces: `apply`, `compact`, `embedding`, `rerank`, and `warpgrep`.

### Interview Summary
- Morph must be a top-level dashboard page, not hidden under generic settings.
- Morph is a special routing integration, not a normal provider record.
- User wants a simple proxy system without translation.
- Morph settings must support multiple API keys plus round-robin toggle.
- When round-robin is disabled, key 0 is primary and later keys are failover-only.
- On eligible upstream failure, the same request retries with the next key.
- Testing remains Vitest-first with agent-executed QA; no new browser E2E framework.
- Scope changed materially: plan must cover five Morph capabilities, not just `apply`.
- User requires at least one live direct-vs-proxied Morph comparison to prove the local proxy preserves transport behavior.

### Metis Review (gaps addressed)
- Reframe from single endpoint proxy to five-capability raw proxy bundle.
- Add explicit non-goals forbidding provider-framework rewrites, schema normalization, and tool-protocol adaptation.
- Decide MVP scope for `compact`: support native `POST /v1/compact` only, not optional OpenAI-compatible compact surfaces.
- Treat `warpgrep` as raw upstream tool-call protocol pass-through only; no local tool mediation.
- Require HTTP-level acceptance criteria per capability, with one success case and one upstream-error case each.

## Work Objectives
### Core Objective
Implement a single Morph integration seam that exposes a dedicated dashboard page and a Morph-only local API namespace for five official Morph capabilities: `apply`, `compact`, `embedding`, `rerank`, and `warpgrep`. Each local route must behave like an Nginx-style upstream proxy: forward to the correct Morph upstream surface using stored credentials, preserve inbound payload semantics, and pass upstream status/body back unchanged while bypassing the app's standard provider translation and normalization pipelines.

### Deliverables
- Top-level sidebar nav entry labeled `Morph`
- New dashboard route/page for Morph configuration and operator guidance
- Persisted settings schema in app settings for Morph base URL, API keys, and round-robin toggle
- Dedicated local Morph namespace with exact capability routes:
  - `POST /api/morph/apply`
  - `POST /api/morph/compact`
  - `POST /api/morph/embeddings`
  - `POST /api/morph/rerank`
  - `POST /api/morph/warpgrep`
- Shared Morph runtime helper for key selection and failover
- Vitest suites proving raw request/response pass-through and isolation from existing provider flows

### Definition of Done (verifiable conditions with commands)
- `Morph` appears in sidebar nav and resolves to a dashboard page using the existing dashboard layout.
- Morph settings persist through the app settings layer and reload correctly after refresh.
- Each local Morph route forwards to the correct documented upstream surface:
  - `apply` -> `POST /v1/chat/completions`
  - `compact` -> `POST /v1/compact`
  - `embedding` -> `POST /v1/embeddings`
  - `rerank` -> `POST /v1/rerank`
  - `warpgrep` -> `POST /v1/chat/completions`
- Morph routes preserve upstream HTTP status and body without translation/parsing.
- Morph routes act as Nginx-like transport proxies rather than application-level adapters.
- Multi-key rotation/failover behavior matches the agreed semantics.
- Standard `/api/v1/*`, provider, translator, and model-normalization flows remain behaviorally unchanged.
- At least one live comparison test proves direct Morph and proxied Morph are equivalent at the transport level for the same request class.
- Relevant tests pass via:
  - `npm --prefix tests exec vitest run --reporter=verbose unit/morph-*.test.js`
  - `npm --prefix tests exec vitest run --reporter=verbose unit/opencode-settings-route.test.js unit/settings-r2-ui.test.js`

### Must Have
- Top-level Morph dashboard page and nav item
- Persisted config fields: `baseUrl`, ordered `apiKeys[]`, `roundRobinEnabled`
- Five Morph-specific local proxy routes with capability-isolated tests
- Raw pass-through request/response behavior
- Retry-next-key behavior on eligible upstream failure
- Reuse existing dashboard layout, sidebar, settings persistence, and auth guard patterns where possible

### Must NOT Have
- No generic custom-provider framework work
- No provider registry redesign or capability abstraction rewrite
- No response translation, model normalization, content parsing, or payload remapping for Morph routes
- No request translation, field remapping, schema conversion, response wrapping, tool-call adaptation, or header invention beyond required auth/proxy forwarding
- No local mediation of WarpGrep built-in tool protocol
- No support for OpenAI-compatible compact surface in MVP; native `/v1/compact` only
- No browser E2E framework setup
- No unrelated dashboard redesign, telemetry expansion, caching, batching, queueing, or resilience platform work

### Non-Goals
- Do not add Morph into `AI_PROVIDERS`, `APIKEY_PROVIDERS`, or standard provider connection records.
- Do not route Morph traffic through `src/app/api/v1/responses/compact/route.js` or other translator-backed `/api/v1/*` flows.
- Do not create a universal "capability proxy" abstraction for all providers.
- Do not adapt local request payloads into a provider-agnostic schema.
- Do not reinterpret Morph payloads; local routes are transport proxies, not API adapters.
- Do not implement WarpGrep local tool execution/orchestration; upstream Morph remains responsible for tool-call protocol.
- Do not hardcode or commit any temporary Morph API key in source, tests, evidence files, or plan artifacts; use an environment variable only and rotate the key after testing.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: tests-after + Vitest
- QA policy: Every task includes automated verification and agent-executed HTTP-level scenarios
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`
- Verification level: transport correctness only; Morph model quality is not part of pass/fail

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. <3 per wave (except final) = under-splitting.
> Extract shared dependencies as Wave-1 tasks for max parallelism.

Wave 1: schema contract, nav shell, page shell, key rotation helper
Wave 2: settings API integration, five capability routes, page wiring
Wave 3: regression and HTTP-level capability coverage consolidation

### Dependency Matrix (full, all tasks)
- 1 blocks 3, 4, 5, 6
- 2 blocks 7
- 3 blocks 7
- 4 blocks 8
- 5 blocks 8
- 6 blocks 8
- 7 blocks 9
- 8 blocks 9
- 9 blocks F1-F4

### Agent Dispatch Summary (wave -> task count -> categories)
- Wave 1 -> 4 tasks -> `backend-developer`, `visual-engineering`, `typescript-pro`
- Wave 2 -> 4 tasks -> `backend-developer`, `fullstack-developer`, `typescript-pro`
- Wave 3 -> 1 task -> `qa-expert`

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. Define Morph settings schema and capability contract

  **What to do**: Extend the app settings contract with a dedicated `morph` object containing exactly `baseUrl`, `apiKeys`, and `roundRobinEnabled`. Canonical defaults: `baseUrl = "https://api.morphllm.com"`, `apiKeys = []`, `roundRobinEnabled = false`. Normalize whitespace, drop empty keys, preserve first-seen order, dedupe exact duplicates, and reject invalid absolute URLs. Document the exact upstream mapping rules: `apply` and `warpgrep` use `POST /v1/chat/completions`, `compact` uses native `POST /v1/compact`, `embeddings` uses `POST /v1/embeddings`, and `rerank` uses `POST /v1/rerank`.
  **Must NOT do**: Do not add Morph into generic provider config collections or create a shared capability schema for other providers.

  **Recommended Agent Profile**:
  - Category: `backend-developer` - Reason: settings contract and configuration normalization
  - Skills: `[]` - no special skill needed
  - Omitted: `api-designer` - contract is intentionally local and narrow

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: [3, 4, 5, 6] | Blocked By: []

  **References**:
  - Pattern: `src/lib/localDb.js:61` - default settings source of truth
  - Pattern: `src/lib/localDb.js:160` - safe settings merge/normalization pattern
  - API/Type: `src/app/api/settings/route.js:18` - settings sanitization flow
  - API/Type: `src/app/api/settings/route.js:69` - PATCH update flow for persisted settings
  - Test: `tests/unit/settings-schema.test.js:1` - settings schema test pattern
  - External: `https://docs.morphllm.com/api-reference/endpoint/apply` - `apply` uses chat completions
  - External: `https://docs.morphllm.com/api-reference/endpoint/compact` - native compact surface
  - External: `https://docs.morphllm.com/api-reference/endpoint/embedding` - embeddings surface
  - External: `https://docs.morphllm.com/api-reference/endpoint/rerank` - rerank surface
  - External: `https://docs.morphllm.com/api-reference/endpoint/warpgrep` - WarpGrep chat-completions protocol

  **Acceptance Criteria**:
  - [ ] `src/lib/localDb.js` defines canonical Morph defaults and normalization for `baseUrl`, `apiKeys`, and `roundRobinEnabled`
  - [ ] Invalid `baseUrl` values are rejected deterministically
  - [ ] Empty and duplicate keys are normalized away while preserving first-seen order
  - [ ] The capability-to-upstream-path mapping is documented in code comments or helper constants where executor can reuse it without guessing

  **QA Scenarios**:
  ```text
  Scenario: Morph settings schema defaults and normalization
    Tool: Bash
    Steps: Run `npm --prefix tests exec vitest run --reporter=verbose unit/morph-settings-schema.test.js`
    Expected: Tests prove defaults, URL validation, trimming, dedupe, and key ordering behavior
    Evidence: .sisyphus/evidence/task-1-morph-settings-schema.txt

  Scenario: Invalid Morph base URL rejected
    Tool: Bash
    Steps: Run targeted Vitest covering malformed `baseUrl` values such as `not-a-url` and relative paths
    Expected: Test passes only if invalid URL handling is deterministic and documented
    Evidence: .sisyphus/evidence/task-1-morph-settings-schema-error.txt
  ```

  **Commit**: YES | Message: `feat(settings): add morph config contract` | Files: [`src/lib/localDb.js`, `src/app/api/settings/route.js`, `tests/unit/morph-settings-schema.test.js`]

- [x] 2. Add top-level Morph nav item and dashboard route shell

  **What to do**: Add a top-level `Morph` nav item to the dashboard sidebar and create a dashboard page route at `src/app/(dashboard)/dashboard/morph/page.js` using the existing dashboard layout. The page shell must explain that Morph is a raw proxy bundle with five capability routes and is separate from normal providers.
  **Must NOT do**: Do not hide Morph under generic settings only, and do not add a second layout system.

  **Recommended Agent Profile**:
  - Category: `visual-engineering` - Reason: route/page/nav implementation using existing dashboard patterns
  - Skills: `[]`
  - Omitted: `design-taste-frontend` - existing product style must be preserved

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [7] | Blocked By: []

  **References**:
  - Pattern: `src/shared/components/Sidebar.js:17` - nav item array and active route handling
  - Pattern: `src/shared/components/layouts/DashboardLayout.js:38` - dashboard shell
  - Pattern: `src/app/(dashboard)/dashboard/providers/new/page.js:19` - dashboard route/page pattern
  - Pattern: `src/app/(dashboard)/dashboard/settings/SettingsPageClient.jsx:82` - page copy and save-feedback structure

  **Acceptance Criteria**:
  - [ ] Sidebar contains `Morph` as a top-level item
  - [ ] `/dashboard/morph` renders inside the existing dashboard layout
  - [ ] Page copy explicitly says Morph is proxy-only and separate from standard providers
  - [ ] Existing nav item active-state behavior remains intact

  **QA Scenarios**:
  ```text
  Scenario: Sidebar shows Morph and route resolves
    Tool: Bash
    Steps: Run targeted tests validating Sidebar source and route file existence; optionally include compile-level assertions if test harness supports them
    Expected: Sidebar contains `/dashboard/morph` entry and route compiles
    Evidence: .sisyphus/evidence/task-2-morph-nav.txt

  Scenario: Existing sidebar active states not regressed
    Tool: Bash
    Steps: Run targeted UI/source tests covering active route logic after adding Morph
    Expected: Test proves Morph addition does not break existing dashboard navigation behavior
    Evidence: .sisyphus/evidence/task-2-morph-nav-error.txt
  ```

  **Commit**: YES | Message: `feat(dashboard): add morph route shell` | Files: [`src/shared/components/Sidebar.js`, `src/app/(dashboard)/dashboard/morph/page.js`]

- [x] 3. Build Morph settings page client with route inventory guidance

  **What to do**: Implement the Morph page client/form using shared cards, inputs, and feedback patterns. Provide `baseUrl` input, ordered multi-key editor, add/remove controls, round-robin toggle, and explicit route inventory showing the exact five local routes and their upstream Morph targets. Help text must explain that when round-robin is off, key 0 is primary and later keys are failover-only.
  **Must NOT do**: Do not use the generic new-provider form, and do not present Morph as model/provider selection UI.

  **Recommended Agent Profile**:
  - Category: `visual-engineering` - Reason: form UX and operator guidance wiring
  - Skills: `[]`
  - Omitted: `ui-ux-pro-max` - preserve established UI language

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [7] | Blocked By: [1]

  **References**:
  - Pattern: `src/app/(dashboard)/dashboard/settings/SettingsPageClient.jsx:86` - page-level load/save state handling
  - Pattern: `src/app/(dashboard)/dashboard/settings/SettingsPageClient.jsx:159` - PATCH save pattern with feedback handling
  - Pattern: `src/app/(dashboard)/dashboard/providers/new/page.js:22` - controlled form state pattern
  - Test: `tests/unit/settings-r2-ui.test.js:15` - source-inspection UI test pattern

  **Acceptance Criteria**:
  - [ ] User can add and remove multiple API keys while preserving entered order
  - [ ] Round-robin toggle is visible, editable, saved, and reloaded
  - [ ] Page displays the exact five local Morph routes with a concise upstream mapping description
  - [ ] Save validation clearly surfaces missing `baseUrl` or zero valid keys

  **QA Scenarios**:
  ```text
  Scenario: Morph settings form renders required controls and route inventory
    Tool: Bash
    Steps: Run `npm --prefix tests exec vitest run --reporter=verbose unit/morph-settings-ui.test.js`
    Expected: Test confirms `baseUrl`, multi-key controls, round-robin toggle, and five-route inventory text render
    Evidence: .sisyphus/evidence/task-3-morph-settings-ui.txt

  Scenario: Morph form rejects missing base URL or empty key list
    Tool: Bash
    Steps: Run targeted UI/helper tests covering empty `baseUrl` and empty key list save attempts
    Expected: Tests prove validation feedback is surfaced deterministically
    Evidence: .sisyphus/evidence/task-3-morph-settings-ui-error.txt
  ```

  **Commit**: YES | Message: `feat(morph): add config dashboard page` | Files: [`src/app/(dashboard)/dashboard/morph/page.js`, `src/app/(dashboard)/dashboard/morph/MorphPageClient.js`, `tests/unit/morph-settings-ui.test.js`]

- [x] 4. Add Morph settings API persistence to existing settings surface

  **What to do**: Extend `GET` and `PATCH` on `/api/settings` to serve and update the canonical Morph settings object. Partial Morph updates must preserve unrelated app settings. Response sanitization must follow the existing settings response pattern and remain consistent with repo precedent for secrets/config APIs.
  **Must NOT do**: Do not persist Morph config in provider-specific APIs, provider nodes, or connection tables.

  **Recommended Agent Profile**:
  - Category: `backend-developer` - Reason: existing settings route contract change
  - Skills: `[]`
  - Omitted: `fullstack-developer` - task is API/settings persistence only

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [8] | Blocked By: [1]

  **References**:
  - API/Type: `src/app/api/settings/route.js:29` - GET shape to extend
  - API/Type: `src/app/api/settings/route.js:69` - PATCH update flow to extend
  - Pattern: `src/app/api/settings/route.js:18` - sanitization helper pattern
  - Pattern: `src/lib/localDb.js:160` - merged settings source of truth
  - Test: `tests/unit/opencode-settings-route.test.js` - route test pattern

  **Acceptance Criteria**:
  - [ ] `GET /api/settings` includes Morph config fields needed by the page
  - [ ] `PATCH /api/settings` updates only provided Morph subfields safely
  - [ ] Existing unrelated settings behavior remains unchanged
  - [ ] Secrets handling follows the same repository precedent already used for settings/config responses

  **QA Scenarios**:
  ```text
  Scenario: Settings API serves and updates Morph config
    Tool: Bash
    Steps: Run `npm --prefix tests exec vitest run --reporter=verbose unit/morph-settings-route.test.js`
    Expected: Tests prove GET/PATCH include Morph fields and preserve unrelated settings
    Evidence: .sisyphus/evidence/task-4-morph-settings-route.txt

  Scenario: Partial Morph PATCH does not clobber existing settings
    Tool: Bash
    Steps: Run targeted route tests patching only `roundRobinEnabled` or only `baseUrl`
    Expected: Tests prove partial updates preserve API key list and unrelated settings
    Evidence: .sisyphus/evidence/task-4-morph-settings-route-error.txt
  ```

  **Commit**: YES | Message: `feat(api): persist morph settings` | Files: [`src/app/api/settings/route.js`, `tests/unit/morph-settings-route.test.js`]

- [x] 5. Implement Morph key selection and failover helper

  **What to do**: Create a dedicated helper/module for Morph key selection. Behavior is fixed: when `roundRobinEnabled=true`, choose keys in stable cyclic order per request and wrap around; when `false`, always start with key index 0. On eligible upstream failure, retry the same request with the next key until keys are exhausted. Eligible failure includes upstream `401`, `429`, `5xx`, network failure, and timeout after dispatch begins; non-retryable request-construction errors before dispatch must fail immediately.
  **Must NOT do**: Do not bury rotation logic inside UI components or generic provider selectors. Do not persist rotation state outside runtime memory unless an existing local pattern already requires it.

  **Recommended Agent Profile**:
  - Category: `typescript-pro` - Reason: deterministic rotation/failover state machine
  - Skills: `[]`
  - Omitted: `oracle` - logic is explicit once contract is fixed

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [8] | Blocked By: [1]

  **References**:
  - Pattern: `src/app/api/settings/route.js:34` - existing settings naming expectations around routing flags
  - Pattern: `src/lib/localDb.js:72` - existing round-robin related defaults in app settings
  - Test: `tests/unit/settings-schema.test.js:1` - deterministic test style pattern

  **Acceptance Criteria**:
  - [ ] Helper selects keys in stable cyclic order when round-robin is enabled
  - [ ] Helper always starts with key 0 when round-robin is disabled
  - [ ] Same request retries across later keys on eligible upstream failure
  - [ ] Zero-key, one-key, and wraparound cases are deterministic and tested

  **QA Scenarios**:
  ```text
  Scenario: Round-robin key order and wraparound
    Tool: Bash
    Steps: Run `npm --prefix tests exec vitest run --reporter=verbose unit/morph-rotation.test.js`
    Expected: Tests prove cyclic ordering, first-key-default mode, one-key, and zero-key behavior
    Evidence: .sisyphus/evidence/task-5-morph-rotation.txt

  Scenario: Failover retries the same request across keys
    Tool: Bash
    Steps: Run targeted tests simulating first-key failure and second-key success, then all-key exhaustion
    Expected: Tests prove retry-next-key behavior and stop conditions when all keys fail
    Evidence: .sisyphus/evidence/task-5-morph-rotation-error.txt
  ```

  **Commit**: YES | Message: `feat(morph): add key rotation helper` | Files: [`src/lib/morph/**`, `tests/unit/morph-rotation.test.js`]

- [x] 6. Guard Morph API namespace and route isolation

  **What to do**: Add the new `/api/morph/:path*` namespace to the same auth/protection surface used for existing protected dashboard APIs if required by repo behavior. Explicitly keep Morph routes isolated from `/api/v1/*`, provider validation routes, and translator-backed handlers.
  **Must NOT do**: Do not loosen auth on existing routes, and do not move existing `/api/v1/*` behavior under Morph.

  **Recommended Agent Profile**:
  - Category: `backend-developer` - Reason: route guard and namespace isolation work
  - Skills: `[]`
  - Omitted: `security-auditor` - this is scoped route matcher maintenance, not a full security review

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [8] | Blocked By: [1]

  **References**:
  - Pattern: `src/proxy.js:3` - current protected API matcher list
  - Pattern: `src/app/api/settings/proxy-test/route.js:1` - small API route structure pattern
  - Anti-pattern: `src/app/api/v1/responses/compact/route.js:1` - translator-backed path Morph must not reuse

  **Acceptance Criteria**:
  - [ ] `/api/morph/:path*` is protected consistently with existing protected dashboard APIs if repo conventions require it
  - [ ] Existing `/api/v1/*` routes remain unchanged
  - [ ] Code clearly prevents Morph from flowing through translator-backed compact/chat handlers

  **QA Scenarios**:
  ```text
  Scenario: Morph namespace is guarded and isolated
    Tool: Bash
    Steps: Run targeted tests or source assertions covering `src/proxy.js` matcher changes and route placement under `src/app/api/morph/**`
    Expected: Tests prove Morph namespace is protected and separate from `/api/v1/*`
    Evidence: .sisyphus/evidence/task-6-morph-namespace.txt

  Scenario: Translator-backed compact route is not reused
    Tool: Bash
    Steps: Add assertions that Morph capability routes do not import or call translator-backed `handleChat` compact pipeline
    Expected: Tests fail if Morph route wiring depends on `/api/v1/responses/compact/route.js`
    Evidence: .sisyphus/evidence/task-6-morph-namespace-error.txt
  ```

  **Commit**: YES | Message: `feat(api): isolate morph namespace` | Files: [`src/proxy.js`, `src/app/api/morph/**`, `tests/unit/morph-namespace.test.js`]

- [x] 7. Implement Apply and Compact raw proxy routes

  **What to do**: Add local Morph routes for `apply` and `compact`. `apply` must forward raw OpenAI-compatible chat-completions payloads to `${baseUrl}/v1/chat/completions`. `compact` MVP must forward native compact payloads to `${baseUrl}/v1/compact` only. Both routes must inject Bearer auth from the selected key, preserve request body shape unchanged, preserve upstream status/body unchanged, and use Task 5 retry rules. Treat these handlers as transport proxies only, like Nginx with auth injection and retry policy.
  **Must NOT do**: Do not translate compact into existing `/api/v1/responses/compact` flow, and do not remap request fields into a provider-agnostic schema.

  **Recommended Agent Profile**:
  - Category: `backend-developer` - Reason: request forwarding and raw transport handling
  - Skills: `[]`
  - Omitted: `api-designer` - endpoint surface is predetermined

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [9] | Blocked By: [2, 5, 6]

  **References**:
  - Pattern: `src/app/api/settings/proxy-test/route.js:1` - minimal POST route structure
  - Anti-pattern: `src/app/api/v1/responses/compact/route.js:1` - translator-backed compact implementation to avoid
  - External: `https://docs.morphllm.com/api-reference/endpoint/apply` - apply path and XML-in-message pattern
  - External: `https://docs.morphllm.com/api-reference/endpoint/compact` - native compact payload and path

  **Acceptance Criteria**:
  - [ ] `POST /api/morph/apply` forwards to `${baseUrl}/v1/chat/completions` with body unchanged
  - [ ] `POST /api/morph/compact` forwards to `${baseUrl}/v1/compact` with body unchanged
  - [ ] Both routes inject selected Bearer auth header and preserve upstream status/body without wrapping or translation
  - [ ] Both routes retry next key on eligible upstream failure and stop after key exhaustion

  **QA Scenarios**:
  ```text
  Scenario: Apply and Compact routes pass through raw payloads successfully
    Tool: Bash
    Steps: Run `npm --prefix tests exec vitest run --reporter=verbose unit/morph-apply-compact-route.test.js`
    Expected: Tests prove correct upstream path selection, auth injection, unchanged request body, and raw response passthrough
    Evidence: .sisyphus/evidence/task-7-morph-apply-compact.txt

  Scenario: Apply and Compact routes preserve upstream errors and retry by key
    Tool: Bash
    Steps: Run targeted route tests mocking `401`, `429`, and `500` upstream responses across multiple keys
    Expected: Tests prove retry order, final exhaustion behavior, and unchanged upstream error bodies
    Evidence: .sisyphus/evidence/task-7-morph-apply-compact-error.txt
  ```

  **Commit**: YES | Message: `feat(api): add morph apply compact proxy` | Files: [`src/app/api/morph/apply/route.js`, `src/app/api/morph/compact/route.js`, `src/lib/morph/**`, `tests/unit/morph-apply-compact-route.test.js`]

- [x] 8. Implement Embeddings, Rerank, and WarpGrep raw proxy routes

  **What to do**: Add local Morph routes for `embeddings`, `rerank`, and `warpgrep`. `embeddings` forwards raw payloads to `${baseUrl}/v1/embeddings`. `rerank` forwards raw payloads to `${baseUrl}/v1/rerank`. `warpgrep` forwards raw OpenAI-compatible chat-completions payloads to `${baseUrl}/v1/chat/completions` and must not interpret or mediate built-in tool-call protocol; it only proxies bytes/status/headers as route policy allows. Treat all three handlers as transport proxies only, not application-level adapters.
  **Must NOT do**: Do not create a local tool adapter for WarpGrep, and do not introduce rerank/embedding normalization or vector-store abstractions.

  **Recommended Agent Profile**:
  - Category: `backend-developer` - Reason: capability-specific route forwarding and protocol isolation
  - Skills: `[]`
  - Omitted: `microservices-architect` - narrow proxy seam only

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [9] | Blocked By: [2, 5, 6]

  **References**:
  - Pattern: `src/app/api/settings/proxy-test/route.js:1` - minimal POST route structure
  - External: `https://docs.morphllm.com/api-reference/endpoint/embedding` - embeddings path and payload pattern
  - External: `https://docs.morphllm.com/api-reference/endpoint/rerank` - rerank path and payload pattern
  - External: `https://docs.morphllm.com/api-reference/endpoint/warpgrep` - WarpGrep chat-completions protocol and built-in tools note

  **Acceptance Criteria**:
  - [ ] `POST /api/morph/embeddings` forwards to `${baseUrl}/v1/embeddings` with body unchanged
  - [ ] `POST /api/morph/rerank` forwards to `${baseUrl}/v1/rerank` with body unchanged
  - [ ] `POST /api/morph/warpgrep` forwards to `${baseUrl}/v1/chat/completions` with body unchanged
  - [ ] WarpGrep route does not adapt local tools or rewrite tool-call payloads
  - [ ] All three routes preserve upstream status/body without wrapping or translation and use Task 5 retry rules

  **QA Scenarios**:
  ```text
  Scenario: Embeddings, Rerank, and WarpGrep routes pass through raw payloads successfully
    Tool: Bash
    Steps: Run `npm --prefix tests exec vitest run --reporter=verbose unit/morph-embeddings-rerank-warpgrep-route.test.js`
    Expected: Tests prove correct upstream path selection, auth injection, unchanged request body, and raw response passthrough
    Evidence: .sisyphus/evidence/task-8-morph-erw-routes.txt

  Scenario: WarpGrep protocol is proxied raw and upstream errors are preserved
    Tool: Bash
    Steps: Run targeted route tests with mocked tool-call payloads and upstream failure responses
    Expected: Tests prove no local tool mediation occurs and upstream error/status bodies remain intact
    Evidence: .sisyphus/evidence/task-8-morph-erw-routes-error.txt
  ```

  **Commit**: YES | Message: `feat(api): add morph capability proxies` | Files: [`src/app/api/morph/embeddings/route.js`, `src/app/api/morph/rerank/route.js`, `src/app/api/morph/warpgrep/route.js`, `src/lib/morph/**`, `tests/unit/morph-embeddings-rerank-warpgrep-route.test.js`]

- [x] 9. Add regression and capability-level HTTP verification coverage

  **What to do**: Consolidate Vitest coverage across settings, namespace isolation, key rotation, and all five capability routes. Add HTTP-level tests with concrete sample bodies for each capability and explicit negative assertions that no new generic provider interface or `/api/v1/*` translation dependency was introduced. Include agent-executed request-path QA against a local dev or controlled mocked environment, but keep assertions transport-focused rather than model-quality-focused.
  **Must NOT do**: Do not add Playwright/Cypress. Do not mark done with only shallow unit coverage and no capability request-path evidence.

  **Recommended Agent Profile**:
  - Category: `qa-expert` - Reason: consolidate regression coverage and proof of raw proxy correctness
  - Skills: `[]`
  - Omitted: `ui-ux-tester` - browser automation is out of scope for this repo's current stack

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: [F1, F2, F3, F4] | Blocked By: [7, 8]

  **References**:
  - Test: `tests/package.json:7` - available Vitest commands
  - Test: `tests/unit/settings-r2-ui.test.js:15` - UI/source-inspection test style
  - Test: `tests/unit/opencode-settings-route.test.js` - API route testing pattern
  - Pattern: `src/app/api/v1/embeddings/route.js` - existing embeddings route surface to ensure non-regression by isolation, not reuse
  - Anti-pattern: `src/app/api/v1/responses/compact/route.js:1` - translation flow Morph must avoid
  - CI: `.github/workflows/docker-publish.yml:1` - local execution evidence required

  **Acceptance Criteria**:
  - [ ] All new Morph-targeted Vitest suites pass
  - [ ] Existing relevant settings/provider route tests still pass if impacted
  - [ ] One success case and one upstream-error case exist for each of the five capabilities
  - [ ] Tests explicitly prove no provider-agnostic payload remapping was introduced
  - [ ] Tests explicitly prove Morph routes do not depend on `/api/v1/*` translator-backed handlers
  - [ ] One live upstream comparison exists for at least `apply`, comparing direct Morph vs `/api/morph/apply` with the same payload shape and confirming that any differences are limited to expected proxy-layer metadata
  - [ ] Live comparison uses a temporary environment variable such as `MORPH_API_KEY_TEMP` and never writes the literal key into repo-tracked files or evidence artifacts

  **QA Scenarios**:
  ```text
  Scenario: Full Morph capability test suite passes
    Tool: Bash
    Steps: Run `npm --prefix tests exec vitest run --reporter=verbose unit/morph-*.test.js`
    Expected: All Morph-targeted suites pass across schema, namespace, rotation, and five capability routes
    Evidence: .sisyphus/evidence/task-9-morph-tests.txt

  Scenario: HTTP-level request flow confirms raw pass-through and failover
    Tool: Bash
    Steps: Start local app or route test harness, configure Morph page with base URL + 2 keys, send representative requests to `/api/morph/apply`, `/api/morph/compact`, `/api/morph/embeddings`, `/api/morph/rerank`, and `/api/morph/warpgrep`, then capture mocked upstream requests and responses
    Expected: Each route hits the correct upstream path, selected key behavior follows plan, request bodies remain unchanged, and response/error bodies are preserved raw
    Evidence: .sisyphus/evidence/task-9-morph-http-qa.txt

  Scenario: Real upstream comparison between direct Morph and proxied Morph
    Tool: Bash
    Steps: Export the temporary key to `MORPH_API_KEY_TEMP`; start the local app; configure Morph settings to use `https://api.morphllm.com` and that same key; send the same minimal `apply` request once directly to Morph and once to `/api/morph/apply`; capture status code, response body, and important transport headers for both while redacting authorization values from logs
    Expected: Direct and proxied calls show equivalent Morph transport behavior for the same request class, response bodies/status are materially identical, and any differences are limited to expected proxy-layer metadata rather than translated payload content
    Evidence: .sisyphus/evidence/task-9-morph-live-compare.txt
  ```

  **Commit**: YES | Message: `test(morph): cover raw proxy bundle` | Files: [`tests/unit/morph-*.test.js`, `.sisyphus/evidence/*`]

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.** Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [x] F1. Plan Compliance Audit — oracle
- [x] F2. Code Quality Review — unspecified-high
- [x] F3. Real Manual QA — unspecified-high (+ playwright if UI)
- [x] F4. Scope Fidelity Check — deep

## Commit Strategy
- Prefer one commit per completed TODO above when changes are meaningfully isolated.
- Keep Morph schema/API/route/UI/test work in separate commits to simplify review.
- Do not mix unrelated provider refactors into Morph commits.

## Success Criteria
- Morph is visible as its own dashboard destination.
- Morph configuration is stored in settings, not provider connections.
- Morph exposes exactly five local capability routes backed by the documented Morph endpoint surfaces.
- `compact` MVP uses native `/v1/compact` only.
- `warpgrep` is proxied as raw upstream protocol with no local tool mediation.
- Request and response handling are raw pass-through with no provider translation/parsing.
- Multi-key round-robin/failover semantics match the fixed decisions captured in this plan.
- Real direct-vs-proxied Morph comparison evidence exists without committing the temporary API key.
- Vitest coverage and HTTP-level QA evidence are sufficient for execution without human guesswork.
