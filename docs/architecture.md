# Architecture

## Goal

Ingest webhook traffic from external systems with low and predictable latency,
regardless of how slow downstream processing is, and stay correct under
duplicate delivery and partial failure.

## High-level shape

```
                +-------------+   accept fast (<50ms)   +-------------+
  Provider ---> |  HTTP API   |  -------------------->  |   Redis     |
  (signed       | (NestJS)    |                          | (BullMQ)    |
   webhook)     +------+------+                          +------+------+
                       |  202 Accepted                          |
                       v                                        v
                  client gets ack                       +-------+--------+
                                                        | Worker fleet   |
                                                        | (NestJS app    |
                                                        |  in worker mode)|
                                                        +-------+--------+
                                                                |
                                                                v
                                                        downstream systems
                                                        (DB, 3rd-party,
                                                         analytics, ...)
```

The HTTP tier and the worker tier run the same NestJS image but with
different entrypoints (`main.ts` vs `worker.ts`). They scale independently
behind a Redis-backed queue.

## Module layout

```
src/
├── main.ts                  HTTP entrypoint (binds port)
├── worker.ts                Worker entrypoint (no HTTP listener)
├── app.module.ts            Wires everything together
├── config/
│   ├── env.validation.ts    Joi schema for typed env config
│   └── redis.config.ts      Shared ioredis options factory
├── common/
│   ├── filters/             Global exception filter (uniform error shape)
│   ├── middleware/          Request-id propagation
│   └── logger/              pino logger module + redaction
├── health/
│   ├── health.controller.ts Liveness + readiness
│   └── redis.health.ts      Redis ping indicator
└── webhook/
    ├── webhook.controller.ts   POST /v1/webhook (auth + enqueue)
    ├── webhook.service.ts      Job builder + dedup
    ├── webhook.processor.ts    BullMQ worker
    ├── webhook.module.ts       Wires queue + controller + processor
    ├── webhook.constants.ts    Header & job-name constants
    ├── webhook.tokens.ts       DI tokens
    ├── dto/                    Payload contract
    └── guards/                 x-webhook-secret guard
```

## Request flow (happy path)

1. Provider POSTs to `POST /v1/webhook` with `x-webhook-secret`.
2. `RequestIdMiddleware` assigns or reuses an `x-request-id`.
3. `ThrottlerGuard` enforces per-IP rate limits.
4. `WebhookSecretGuard` verifies the secret with `crypto.timingSafeEqual`.
5. `ValidationPipe` strips unknown fields and validates the payload DTO.
6. `WebhookController.ingest`:
   - If `x-idempotency-key` is present, checks the queue for a prior job.
   - Otherwise calls `queue.add` with retry/backoff config.
7. Returns `202 Accepted` with `{ accepted, jobId, deduplicated }`.
8. Independently, a worker picks up the job from Redis and calls
   `WebhookProcessor.process`. Errors trigger BullMQ's retry policy with
   exponential backoff; the job goes to `failed` after N attempts.

## Why accept fast

- Most providers (Stripe, Shopify, Twilio, GHL, etc.) treat anything slower
  than a few seconds as a delivery failure and retry, multiplying load.
- Doing real work synchronously couples your availability to the slowest
  downstream dependency.
- The 202+queue pattern lets you absorb spikes (10x traffic surges) by
  letting the queue grow temporarily while workers catch up.

## Failure model

| Failure                          | Behavior                                                |
| -------------------------------- | ------------------------------------------------------- |
| Bad/missing secret               | 401, no enqueue                                         |
| Payload validation fails         | 400, no enqueue                                         |
| Redis temporarily unreachable    | 5xx from `queue.add`; provider retries                  |
| Worker crashes mid-job           | BullMQ stalled-check reclaims, attempt counter advances |
| Job throws inside processor      | Retry with exponential backoff; ends in `failed` state  |
| Duplicate delivery (same idem)   | 202 with `deduplicated: true`, no second enqueue        |

## Stateless property

The HTTP tier holds no per-connection state. All state (jobs, dedup keys,
rate-limit counters when configured for Redis) lives in Redis. This means
every API instance is interchangeable — kill any pod, traffic just goes to
the others.

See [`scalability.md`](./scalability.md) for the full scaling model.
