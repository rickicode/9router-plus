## 2026-04-27T15:19:43Z Session bootstrap
- Morph local routes are fixed to `/api/morph/apply`, `/api/morph/compact`, `/api/morph/embeddings`, `/api/morph/rerank`, and `/api/morph/warpgrep`.
- Upstream mapping is fixed by plan: `apply` and `warpgrep` -> `/v1/chat/completions`, `compact` -> `/v1/compact`, `embeddings` -> `/v1/embeddings`, `rerank` -> `/v1/rerank`.
- Round-robin off means key index 0 primary and later keys failover-only; eligible upstream failures retry across later keys.

## 2026-04-27T15:32:58Z Morph rotation state scope
- Kept Morph key rotation cursor state in module memory (`Map`) keyed by Morph route/use-site so later raw proxy routes can reuse deterministic rotation without persisting operational state to local DB or mixing with global provider routing.
