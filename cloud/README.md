# 9Router Cloud Worker

Deploy your own Cloudflare Worker to access 9Router from anywhere.

## Features

### Routing

- **Round-Robin**: Distribute requests across multiple credentials per provider
- **Sticky Sessions**: Maintain consistent routing for duration
- **Usage Tracking**: Real-time statistics per connection

### Endpoints

- `POST /sync/:machineId` - Sync config from 9Router (includes settings)
- `GET /worker/usage/:machineId` - Get usage statistics
- `GET /worker/health/:machineId` - Get health status
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

# 3. Create D1 database
wrangler d1 create proxy-db

# 4. Paste D1 ID into wrangler.toml
# Edit wrangler.toml and replace YOUR_D1_DATABASE_ID

# 5. Init database & deploy
wrangler d1 execute proxy-db --remote --file=./migrations/0001_init.sql
npm run deploy
```

Copy your Worker URL → 9Router Dashboard → **Endpoint** → **Setup Cloud** → paste → **Save** → **Enable Cloud**.
