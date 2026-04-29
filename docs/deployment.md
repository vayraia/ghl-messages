# Deployment

## Two workloads, one image

Build the image once and run it as two different processes:

| Workload | Command              | Purpose                              |
| -------- | -------------------- | ------------------------------------ |
| `api`    | `node dist/main.js`  | HTTP ingestion (binds `PORT`)        |
| `worker` | `node dist/worker.js`| BullMQ consumer (no HTTP listener)   |

Running them as separate processes means worker pressure cannot starve
the API event loop, and you can scale them on different signals
(API on RPS, worker on queue depth).

## Container

A multi-stage `Dockerfile` is included:

```bash
docker build -t go-high-level:local .
docker run --rm -p 3000:3000 \
  --env-file .env \
  go-high-level:local
```

For the worker:

```bash
docker run --rm \
  --env-file .env \
  go-high-level:local node dist/worker.js
```

## Docker Compose (recommended for single-host deploys)

The bundled `docker-compose.yml` brings up Redis, the API and the
worker together:

```bash
docker compose build
docker compose up -d
```

Scale the worker tier without touching the API:

```bash
docker compose up -d --scale worker=4
```

Tail logs:

```bash
docker compose logs -f api worker
```

Stop everything (Redis volume is preserved):

```bash
docker compose down
```

## Process supervisors (no Docker)

If you prefer running the binaries directly under a process supervisor
(systemd, PM2, supervisord), point two services at the same compiled
output:

- **API service**: `WorkingDirectory=/srv/go-high-level`, `ExecStart=/usr/bin/node dist/main.js`
- **Worker service**: same WorkingDirectory, `ExecStart=/usr/bin/node dist/worker.js`

Both must read the same `.env` (or have the same env vars exported) so
they share `REDIS_URL` and `WEBHOOK_SECRET`.

## Autoscaling signals

- **API** — scale on CPU or RPS. The 202+queue pattern keeps p99 latency
  flat regardless of downstream pressure, so RPS is the cleaner signal.
- **Worker** — scale on **queue depth**, not CPU. Inspect
  `queue.getJobCounts()` (or use a Redis CLI: `LLEN bull:webhook-events:wait`)
  and add/remove worker replicas when the waiting count crosses your
  thresholds.

## Secrets

`WEBHOOK_SECRET` should live in your secrets manager (Doppler, Vault,
AWS Secrets Manager, etc.) — never committed. The schema enforces a
16-char minimum, but in production aim for 32+ random bytes:

```bash
openssl rand -hex 32
```

`REDIS_URL` typically contains credentials too — treat it the same way.

## Rolling restarts

- **API**: roll one replica at a time. New replicas only accept traffic
  once `/v1/health/ready` returns 200 (Redis reachable).
- **Worker**: send `SIGTERM`. BullMQ's `Worker.close()` stops claiming
  new jobs and waits for the current one to finish; jobs that exceed the
  shutdown grace window are automatically reclaimed by another worker
  after the BullMQ stalled-check interval. Give the supervisor enough
  grace time (≥ p95 job duration) before issuing `SIGKILL`.

## What is **not** in scope here

- TLS termination — handle at your load balancer / reverse proxy.
- Distributed throttler storage — the in-memory `@nestjs/throttler`
  store is per-process. Either accept that the effective limit is
  `THROTTLE_LIMIT × replicas`, or wire `@nestjs/throttler-storage-redis`.
- Webhook signature verification beyond the shared secret — for HMAC
  signatures (Stripe-style), extend `WebhookSecretGuard` to compute and
  compare an HMAC of the raw body.
