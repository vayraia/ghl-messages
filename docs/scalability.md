# Scalability

The service is built so each tier can scale independently and failure in
one tier does not cascade to the other.

## Three tiers, three knobs

| Tier   | Knob                          | Where                                          |
| ------ | ----------------------------- | ---------------------------------------------- |
| API    | Number of replicas            | `docker compose up -d --scale api=N` / N hosts |
| Queue  | Redis CPU / mem / connections | Managed Redis or Redis Cluster                 |
| Worker | Replicas × concurrency        | `WEBHOOK_WORKER_CONCURRENCY` env + N replicas  |

Effective worker throughput = `replicas * WEBHOOK_WORKER_CONCURRENCY`.

## Vertical scaling (per-process)

- **Async I/O end to end.** No `fs.*Sync`, no blocking work in handlers.
- **`bodyParser` limit** (`BODY_LIMIT`, default `1mb`) caps payload size so a
  single malicious request cannot starve event-loop turns.
- **Compression** is enabled for responses; webhook responses are tiny
  anyway, so the win comes from health/admin endpoints.
- **`@nestjs/throttler`** caps inbound RPS per IP — the default is
  600 rpm (`THROTTLE_LIMIT` / `THROTTLE_TTL_SECONDS`). Tune up for trusted
  providers, down for public surfaces.

## Horizontal scaling (cluster of processes)

- The API tier is **stateless**. Run N replicas behind any L4/L7 load
  balancer (NGINX, HAProxy, Caddy, a managed LB, …). No sticky sessions
  needed.
- Worker replicas pull from the same BullMQ queue. Adding a replica
  immediately increases throughput; removing one is safe — in-flight jobs
  finish under the shutdown grace period and stalled jobs are reclaimed
  by the next worker.
- **Redis is the bottleneck after a certain scale.** When a single Redis
  saturates: shard the queue (e.g. `webhook-events:{tenantId}`) or move to
  Redis Cluster. BullMQ supports both.

## Burst absorption

A queue lets the API accept faster than the workers can drain. During a
spike:
1. API responds 202 in <50ms regardless of worker pressure.
2. Queue depth grows.
3. More worker replicas come online (manually via
   `docker compose up -d --scale worker=N`, or via your supervisor /
   autoscaler watching queue depth).
4. Queue drains.

Rule of thumb: size the worker fleet so that, on the 95th percentile
spike you care about, queue depth never exceeds ~1 minute of work.

## Idempotency and exactly-once-ish

- BullMQ guarantees at-least-once delivery to a worker.
- The `x-idempotency-key` header pins a job id, so the same key arriving
  twice returns `deduplicated: true` instead of enqueuing again.
- The processor must therefore be **idempotent** — design downstream
  side-effects to tolerate replay (use unique constraints, upserts,
  conditional writes).

## Backpressure

- BullMQ blocks `queue.add` only when Redis is unhealthy; otherwise the
  enqueue is essentially free.
- Workers respect `concurrency`. Lowering it under load is the cleanest
  way to relieve pressure on a struggling downstream — the queue absorbs
  the difference.

## Graceful shutdown

- `app.enableShutdownHooks()` makes Nest call `OnModuleDestroy` and close
  the BullMQ Worker, which stops claiming new jobs and waits for the
  current one to finish before exiting.
- Make sure the supervisor (Docker, systemd, PM2, …) waits at least the
  95p job duration plus a buffer between `SIGTERM` and `SIGKILL`.

## Observability

- **`x-request-id`** is generated or echoed back and attached to every
  log line via `nestjs-pino`.
- Logs redact `x-webhook-secret` and `authorization` headers.
- Health: `/v1/health/live` (cheap), `/v1/health/ready` (Redis ping).
- Recommended add-ons (out of scope for this scaffold): Prometheus
  exporter, OpenTelemetry traces, BullMQ board UI for ops.

## Capacity planning cheat sheet

| Target                         | Setup                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------- |
| ~100 rps, p99 < 100ms ack      | 2 API replicas, 2 worker replicas, concurrency 20, single Redis                  |
| ~1k rps                        | 6 API replicas, 6 worker replicas, concurrency 50, Redis with persistence        |
| >5k rps                        | Shard by tenant or Redis Cluster, separate worker pool per shard, scale workers on queue depth |
