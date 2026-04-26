# 9Router Cloud Worker

Deploy your own Cloudflare Worker to access 9Router from anywhere.

## Features

### Routing

- **Round-Robin**: Distribute requests across multiple credentials per provider
- **Sticky Sessions**: Maintain consistent routing for duration
- **Usage Tracking**: Real-time statistics per connection

### Storage (R2)

All data is stored in Cloudflare R2 — no D1 database needed. This eliminates
the `SQLITE_TOOBIG` error that occurs with hundreds of provider accounts.

- **Provider data**: Stored as individual JSON objects per machine
- **Settings**: Worker configuration (round-robin, sticky, etc.) in JSON
- **Usage backup**: Daily usage snapshots for analytics
- **Request logs**: Request history backup
- **SQLite backup**: Periodic 9Router SQLite database backup for disaster recovery

### Endpoints

- `POST /sync/:machineId` - Sync config from 9Router (includes settings)
- `GET /worker/usage/:machineId` - Get usage statistics
- `GET /worker/health/:machineId` - Get health status
- `POST /v1/chat/completions` - Chat with routing
- `POST /v1/messages` - Claude format with routing

### R2 Backup/Restore Endpoints

- `GET /r2/info?machineId=X` - Storage status info
- `POST /r2/backup/sqlite/:machineId` - Upload SQLite backup
- `GET /r2/backup/sqlite?machineId=X` - List SQLite backups
- `GET /r2/backup/sqlite/download?machineId=X&key=Y` - Download backup
- `GET /r2/export/:machineId` - Export all data (for restore/rollback)
- `POST /r2/usage/:machineId` - Backup usage data
- `POST /r2/requests/:machineId` - Backup request logs

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

# 3. Create R2 bucket
wrangler r2 bucket create 9router-data

# 4. Deploy
npm run deploy
```

Copy your Worker URL → 9Router Dashboard → **Endpoint** → **Setup Cloud** → paste → **Save** → **Enable Cloud**.

### R2 Setup

The worker uses R2 for all data storage. If your R2 bucket name differs from
`9router-data`, edit `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "R2_DATA"
bucket_name = "your-bucket-name"
```

### Multi-Account R2

If your R2 bucket is on a different Cloudflare account, use jurisdiction
or cross-account access. Configure in `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "R2_DATA"
bucket_name = "9router-data"
jurisdiction = "eu"  # optional
```
