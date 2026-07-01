# Local development

## Prerequisites

- Node.js ≥ 20
- npm 10.x (bundled with Node)
- Docker (optional; used for the bundled Redis)

## First-time setup

```bash
npm install
```

Create a `.env` at the repo root. Copy the template below — these are the
same keys validated by `src/config/env.validation.ts`.

```env
# --- HTTP server ---
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
BODY_LIMIT=1mb

# --- Webhook auth ---
# Generate with: openssl rand -hex 32
WEBHOOK_SECRET=replace-me-with-a-long-random-string

# --- Throttling (per-IP, sliding window) ---
THROTTLE_TTL_SECONDS=60
THROTTLE_LIMIT=600

# --- Redis (BullMQ + debounce + idempotency) ---
# redis[s]://[user[:password]@]host[:port][/db]
REDIS_URL=redis://localhost:6379/0

# --- Worker / queue ---
WEBHOOK_WORKER_CONCURRENCY=20
WEBHOOK_JOB_ATTEMPTS=5
WEBHOOK_JOB_BACKOFF_MS=2000

# --- Debounce / dedup ---
# Time window (ms) the debouncer waits after the last inbound message
# before flushing the concatenated text downstream.
MESSAGE_DEBOUNCE_MS=10000
# How long an x-idempotency-key is remembered as "already seen".
IDEMPOTENCY_TTL_SECONDS=3600
# Debug toggle: log the FULL raw /webhook/v1/inbound payload (pre-whitelist) at
# INFO. Verbose — flip on only to capture sample payloads, then turn back off.
LOG_INBOUND_RAW=false

# --- Chat API (your AI service) ---
# Root URL only. The worker POSTs to ${CHAT_API_URL}/chat and expects a
# JSON response { "message": "<reply>" }.
CHAT_API_URL=https://your-chat-api.example.com
CHAT_API_TIMEOUT_MS=15000

# --- GHL outbound ---
GHL_API_KEY=replace-with-your-ghl-pat
GHL_API_BASE_URL=https://services.leadconnectorhq.com
GHL_API_VERSION=2021-07-28
GHL_API_TIMEOUT_MS=10000
```

Boot fails fast on a missing or weak secret — the schema requires
`WEBHOOK_SECRET` ≥ 16 chars, and `GHL_API_KEY` / `CHAT_API_URL` to be
present.

## Running

Bring Redis up:

```bash
docker compose up -d redis
```

In one terminal, run the API:

```bash
npm run start:dev
```

In another, run the worker (optional in dev — the API hosts the
processor by default):

```bash
npm run build && node dist/worker.js
```

Smoke test the webhook:

```bash
curl -i -X POST http://localhost:3000/v1/webhook \
  -H "content-type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{
        "agent_id": "ventas",
        "contact_id": "test-contact",
        "message": { "body": "hola" }
      }'
```

You should see `202 Accepted` immediately. After `MESSAGE_DEBOUNCE_MS`
the worker logs:

1. `Flushing debounced messages` (drained = 1)
2. `Chat API replied`
3. `GHL accepted reply`

## Tests

```bash
npm test             # unit tests (jest)
npm run test:cov     # with coverage
npm run test:e2e     # end-to-end against an in-memory Nest app
```

The e2e test mocks the BullMQ queue **and** the dedicated Redis client
the debouncer uses, so it does **not** require a real Redis. Unit tests
are fully isolated.

## Useful commands

| Command            | What it does                                |
| ------------------ | ------------------------------------------- |
| `npm run lint`        | ESLint + Prettier autofix                |
| `npm run format`      | Prettier-only autoformat                 |
| `npm run build`       | Compile to `dist/`                       |
| `npm run start:prod`  | Run the compiled API                     |
| `npm run start:worker`| Run the compiled worker                  |
