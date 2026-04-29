# Share Chat

Temporary, self-destructing chat rooms. Create a room, share the link and PIN, chat with files and images -- everything auto-expires after inactivity.

**Demo: [share-chat.ruo.workers.dev](https://share-chat.ruo.workers.dev)**

No registration required. No data persistence beyond the TTL.

English | [中文](./README_CN.md)

## Features

- **Ephemeral rooms** -- 6-character room ID + 4-digit PIN. Configurable TTL: 1h / 6h / 12h / 24h. Rooms auto-destroy after inactivity.
- **Chat-style messaging** -- Text, images (inline preview), and file attachments (up to 100 MB). Ctrl+V to paste images. Files auto-upload on selection.
- **Room sharing** -- QR code generation, one-click copy link + PIN to clipboard.
- **Room browser** -- Landing page lists active rooms with member count, message count, and time until expiry.
- **Rate limiting** -- Progressive cooldowns on wrong PINs (3 fails -> delays, 6 fails -> 30 min block). Creation rate limit (3 per 10 min, 10+ triggers 60 min block).
- **Cloudflare Turnstile** -- Optional CAPTCHA kicks in after rate limit thresholds for both room creation and joining.
- **Multi-language** -- Auto-detects browser language. Supports: Chinese, English, German, French, Japanese, Spanish.
- **Auto-naming** -- Users get assigned names (Alice, Bob, Charlie...) based on IP, no login needed.

## Quick Start (Local)

```bash
npm install
node server.js
```

Server starts on `http://localhost:3456`. Also binds to `0.0.0.0` and prints LAN IPs for access from other devices on the same network.

Set port via environment variable:

```bash
PORT=8080 node server.js
```

## Deploy to Cloudflare Workers

The Cloudflare Worker version uses KV for room storage and R2 for file storage.

### Prerequisites

1. A Cloudflare account
2. [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed and authenticated

### Setup

```bash
cd cloudflare-worker

# Create KV namespace
wrangler kv namespace create ROOMS

# Create R2 bucket
wrangler r2 bucket create share-chat-files
```

Update `wrangler.toml` with your KV namespace ID and R2 bucket name:

```toml
name = "share-chat"
main = "src/worker.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "ROOMS"
id = "YOUR_KV_NAMESPACE_ID"

[[r2_buckets]]
binding = "FILES"
bucket_name = "share-chat-files"
```

### Deploy

```bash
wrangler deploy
```

### Optional: Turnstile (CAPTCHA)

Set environment variables in Cloudflare dashboard or via wrangler:

```bash
wrangler secret put TURNSTILE_SITE_KEY
wrangler secret put TURNSTILE_SECRET_KEY
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3456` | Server port (local mode only) |
| `TURNSTILE_SITE_KEY` | No | -- | Cloudflare Turnstile site key |
| `TURNSTILE_SECRET_KEY` | No | -- | Cloudflare Turnstile secret key |

## API

All room operations require the room ID in the URL path. Message and file operations require the PIN.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/room/create` | -- | Create a room. Body: `{ "ttl": 1 }` |
| `POST` | `/api/room/:id/join` | -- | Join room. Body: `{ "pin": "1234" }` |
| `GET` | `/api/room/:id/info` | -- | Room metadata (no PIN needed) |
| `POST` | `/api/room/:id/send` | PIN | Send message. FormData: `pin`, `sender`, `text`, `file` |
| `GET` | `/api/room/:id/messages` | PIN | Fetch messages. Query: `pin`, `since` |
| `GET` | `/api/room/:id/file/:msgId` | PIN | Download attached file |
| `DELETE` | `/api/room/:id/message/:msgId` | PIN | Delete a message |
| `GET` | `/api/rooms` | -- | List active rooms |
| `GET` | `/api/turnstile/config` | -- | Get Turnstile site key (if configured) |

## Project Structure

```
.
├── server.js                  # Node.js Express server (local mode)
├── public/
│   └── index.html             # SPA frontend (local mode)
├── package.json
└── cloudflare-worker/
    ├── wrangler.toml           # Wrangler config
    ├── package.json
    └── src/
        └── worker.js           # Cloudflare Worker (includes embedded HTML)
```

## License

MIT
