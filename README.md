# go-high-level

Highly scalable webhook ingestion service built with NestJS and yarn.

The `POST /v1/webhook` endpoint authenticates the caller via the
`x-webhook-secret` header, enqueues the event onto a Redis-backed BullMQ
queue, and acknowledges with `202 Accepted` in milliseconds. Background
workers drain the queue with retry, exponential backoff, and at-least-once
delivery semantics.

## Quickstart

```bash
yarn install
docker compose up -d redis
cp -n .env.local .env  # then edit WEBHOOK_SECRET (see docs/local-development.md)
yarn start:dev
```

```bash
curl -i -X POST http://localhost:3000/v1/webhook \
  -H "content-type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{ "event": "ping" }'
```

## Tests

```bash
yarn test       # unit
yarn test:e2e   # end-to-end (queue mocked, no Redis required)
yarn test:cov   # coverage
```

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — module layout & request flow
- [`docs/scalability.md`](docs/scalability.md) — how each tier scales
- [`docs/webhook-api.md`](docs/webhook-api.md) — endpoint contract & headers
- [`docs/deployment.md`](docs/deployment.md) — Docker & Compose deployment
- [`docs/local-development.md`](docs/local-development.md) — dev loop & env reference

## License

UNLICENSED — internal.
