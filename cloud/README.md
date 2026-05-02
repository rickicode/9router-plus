# 9Router Cloud Worker

Deploy your own Cloudflare Worker to access 9Router from anywhere.

## Features

### Routing

- **Round-Robin**: Distribute requests across multiple credentials per provider
- **Sticky Sessions**: Maintain consistent routing for duration
- **Usage Tracking**: Real-time statistics per connection

### Authentication

The worker now uses a single shared secret for admin communication.

- Set `CLOUD_SHARED_SECRET` in the worker environment
- Enter the same value in the 9Router dashboard when adding the worker
- 9Router sends the secret via `X-Cloud-Secret`
- The worker accepts register, sync, status, log inspection, and usage requests only when the secret matches

### Storage

Live runtime state uses Cloudflare D1.

- **D1**: primary and only worker-side runtime source of truth for synced credentials/config plus mutable cloud routing state
- **R2**: owned by `9router` directly for backup/export outside the worker; no worker R2 binding is required
- Live chat, embeddings, and routing decisions should read from D1 when the worker has a `DB` binding
- `/sync/:machineId` is the normal one-way publish path from `9router` into worker D1

### Endpoints

- `POST /admin/register` - Verify the shared secret and register the worker
- `GET /admin/status.json` - Read worker status using the shared secret
- `GET /admin/status?token=...` - Open the HTML status dashboard
- `GET /admin/logs.json` - Read recent worker logs using the shared secret
- `GET /admin/usage/events` - Read buffered usage events
- `POST /sync/:machineId` - Upsert publisher-owned runtime/config data into D1 using the shared secret
- `POST /v1/chat/completions` - Chat with routing
- `POST /v1/messages` - Claude format with routing

### Settings

Configure in 9Router dashboard:

- `roundRobin`: Enable round-robin per provider
- `sticky`: Enable sticky sessions
- `stickyDuration`: Sticky duration in seconds
- `comboStrategy`: Default combo fallback strategy

## Setup

```bash
# 1. Login to Cloudflare
npm install -g wrangler
wrangler login

# 2. Install dependencies
cd cloud
npm install

# 3. Create D1 database and apply migrations
wrangler d1 create 9router-runtime
wrangler d1 migrations apply DB

# 4. Configure shared secret in worker env
wrangler secret put CLOUD_SHARED_SECRET

# 5. Deploy
npm run deploy
```

Copy your Worker URL -> 9Router Dashboard -> **Endpoint** -> **Cloud** -> paste the URL and enter the same shared secret.

### D1 Setup

Bind the live runtime database in `wrangler.toml` and replace the placeholder `database_id` before deploying.

`9router` may still use R2 for its own backup/export flows, but that storage is no longer part of worker deployment.

Update `wrangler.toml` with your real D1 `database_id` before deploying.
