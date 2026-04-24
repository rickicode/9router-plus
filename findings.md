# Findings

## Initial state
- User reported a scale bug on `/dashboard/providers` with 800+ Codex provider accounts.
- User wants quota tracker pagination, search, and status filters: active, quota exhausted, revoked/invalid.
- User wants quota usage refresh to stop refreshing constantly and use a queue-based approach, likely with Redis.

## Research in progress
- Waiting on codebase scans for provider dashboard flow, quota tracker flow, and Redis queue documentation.

## Go proxy findings
- Entrypoint Go proxy ada di `go-proxy/main.go`; startup sangat tipis: load config via `config.LoadFromArgs`, lalu `http.ListenAndServe(addr, routes.NewRoutes(cfg))`.
- Route publik Go proxy hanya melayani 4 endpoint: `GET /health`, `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`.
- Jalur OpenAI-compatible memakai `handleOpenAI`, sedangkan jalur Anthropic-compatible memakai `handleAnthropic`; keduanya masuk ke `handleProxy` dengan `protocolFamily` berbeda.
- `handleProxy` memvalidasi method POST, membaca public API key dari `Authorization: Bearer ...` atau `x-api-key`, lalu membaca seluruh request body dan mengekstrak `model` + `stream` dari JSON.
- Setelah itu Go proxy memanggil control-plane 9router ke `POST /api/internal/proxy/resolve` dengan header `x-internal-auth`, membawa `provider`, `model`, `protocolFamily`, dan `publicPath`.
- Hasil resolve berisi `provider`, `model`, `chosenConnectionID`, dan `fallbackConnectionIDs`.
- Untuk setiap connection ID, Go proxy membaca credential dari file lokal `db.json` melalui `internal/credentials/reader.go`; file dibaca ulang penuh setiap lookup.
- Upstream URL tidak dikirim dari resolver; Go proxy membangun sendiri URL berdasarkan provider credential: `openai -> https://api.openai.com`, `anthropic|claude -> https://api.anthropic.com`, lalu menambahkan public path asli.
- Header auth publik dihapus sebelum forward. Untuk OpenAI-compatible, proxy inject `Authorization: Bearer <apiKey/accessToken>`. Untuk Anthropic-compatible, proxy inject `x-api-key` dan/atau `Authorization: Bearer <accessToken>` plus `anthropic-version: 2023-06-01`.
- Fallback utama berada di `forwardResolved`: coba chosen connection dulu, lalu fallback chain. Jika credential tidak ada atau provider tidak dikenali, target dilewati. Jika semua gagal, error menjadi `no routable upstream targets`.
- Streaming dipassthrough langsung ke client. Saat stream berjalan, proxy memakai `io.TeeReader` untuk meng-capture bukti `usage`/`quotas` dari SSE `data:` lines atau payload JSON, lalu melaporkannya.
- Setelah selesai atau gagal, Go proxy mengirim outcome ternormalisasi ke `POST /api/internal/proxy/report`. Pelaporan bersifat fire-and-forget (`reportOutcome` mengabaikan error reporter).
- `LatencyMs` saat ini selalu `0`; observability masih minimal.
- Tests yang memverifikasi perilaku utama ada di `go-proxy/internal/http/routes_test.go`, `go-proxy/internal/proxy/forwarder_test.go`, `go-proxy/internal/resolve/client_test.go`, dan `go-proxy/internal/credentials/reader_test.go`.
