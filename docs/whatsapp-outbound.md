# WhatsApp Cloud — Outbound Sending

Sends messages directly through the **WhatsApp Cloud API** (Meta Graph API),
multi-tenant, queued via BullMQ. This is the outbound counterpart to the
log-only Meta inbound webhook (`/v1/webhook/meta`).

> **Feature flag.** Everything here is gated behind `META_OUTBOUND_ENABLED`
> (default `false`). With the flag off, neither Postgres nor this module are
> wired and the service boots exactly as before (the Redis-only inbound path is
> unaffected). See [Enabling](#enabling).

## Endpoints

All endpoints use the same `x-webhook-secret` authentication as the inbound
webhook (constant-time compared against `WEBHOOK_SECRET`).

### `POST /v1/messages/whatsapp` — send a message

Validates the message against the Cloud API limits, dedupes it, and enqueues
it. The actual send happens asynchronously in the worker, so the response is a
`202` with the job id (no `wamid` yet — see [follow-ups](#remaining-work--follow-ups)).

| Field            | Type   | Required | Notes                                                        |
| ---------------- | ------ | -------- | ------------------------------------------------------------ |
| `phoneNumberId`  | string | one of¹  | Sender's WhatsApp `phone_number_id`; selects tenant creds    |
| `locationId`     | string | one of¹  | GHL location id; resolved 1:1 to a channel (`404` if unregistered) |
| `to`             | string | yes      | Recipient phone in international format (digits)             |
| `message`        | object | yes      | The message — see [message types](#message-types)           |
| `idempotencyKey` | string | no       | Dedupe key (may also be sent via `x-idempotency-key` header) |

¹ Provide **either** `phoneNumberId` **or** `locationId` as the routing
selector. If both are present, `phoneNumberId` wins. `locationId` requires a
channel registered with that `location_id` (a 1:1 partial-unique mapping);
otherwise the send returns `404`.

Response `202`:

```json
{ "accepted": true, "jobId": "wa_123_1714281600000-a3f1d2c4", "deduplicated": false }
```

- `400` — the message violates a Cloud API limit (rejected before enqueue).
- `401` — missing/invalid `x-webhook-secret`.
- `deduplicated: true` — `idempotencyKey` matched a previous send within
  `IDEMPOTENCY_TTL_SECONDS`.

### Message types

`message.type` is a discriminator. Supported shapes:

| `type`     | Fields                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| `text`     | `body` (≤4096), `previewUrl?`                                          |
| `image`    | `link`, `caption?` (≤1024)                                            |
| `document` | `link`, `filename?`, `caption?`                                       |
| `audio`    | `link`                                                                 |
| `video`    | `link`, `caption?`                                                    |
| `buttons`  | `body`, `buttons[]` (≤3; `{id, title≤20}`), `header?`, `footer?`     |
| `list`     | `body`, `button` (≤20), `sections[]` (≤10 rows total), `header?`, `footer?` |
| `template` | `name`, `language` (e.g. `en_US`), `components?`                      |

Limits are enforced by `buildSendBody` (`src/meta-outbound/whatsapp-message.ts`)
and a violation returns `400`. Reply-button / list interactive limits: ≤3 reply
buttons (title ≤20), ≤10 list rows total, section title ≤24, row title ≤24, row
description ≤72.

Examples:

```bash
# Text
curl -X POST http://localhost:3000/v1/messages/whatsapp \
  -H "x-webhook-secret: $WEBHOOK_SECRET" -H "content-type: application/json" \
  -d '{"phoneNumberId":"123","to":"5493510000000",
       "message":{"type":"text","body":"Hola 👋"}}'

# Reply buttons
curl -X POST http://localhost:3000/v1/messages/whatsapp \
  -H "x-webhook-secret: $WEBHOOK_SECRET" -H "content-type: application/json" \
  -d '{"phoneNumberId":"123","to":"5493510000000",
       "message":{"type":"buttons","body":"¿Confirmás el turno?",
         "buttons":[{"id":"yes","title":"Sí"},{"id":"no","title":"No"}]}}'

# Interactive list
curl -X POST http://localhost:3000/v1/messages/whatsapp \
  -H "x-webhook-secret: $WEBHOOK_SECRET" -H "content-type: application/json" \
  -d '{"phoneNumberId":"123","to":"5493510000000",
       "message":{"type":"list","body":"Elegí un servicio","button":"Ver opciones",
         "sections":[{"title":"Limpieza","rows":[{"id":"clean","title":"Limpieza dental"}]}]}}'

# Document (file)
curl -X POST http://localhost:3000/v1/messages/whatsapp \
  -H "x-webhook-secret: $WEBHOOK_SECRET" -H "content-type: application/json" \
  -d '{"phoneNumberId":"123","to":"5493510000000",
       "message":{"type":"document","link":"https://cdn.example.com/presupuesto.pdf",
         "filename":"presupuesto.pdf","caption":"Tu presupuesto"}}'
```

> **24-hour window.** WhatsApp only allows free-form messages within 24h of the
> contact's last inbound message. Outside that window you must send an approved
> `template`; a free-form send returns a re-engagement error that the worker
> treats as non-retryable.

### `*/v1/meta-channels` — manage tenant credentials

Admin CRUD over the per-tenant credential store. **The access token is
write-only**: it is set on create and never returned by any read endpoint.

| Method & path                      | Purpose                                            |
| ---------------------------------- | -------------------------------------------------- |
| `POST /v1/meta-channels`           | Create / update a channel (upsert by `phoneNumberId`) |
| `GET /v1/meta-channels`            | List channels (no tokens)                          |
| `GET /v1/meta-channels/:phoneNumberId` | Get one channel (no token) — `404` if absent   |
| `DELETE /v1/meta-channels/:phoneNumberId` | Delete a channel — `404` if absent          |

`POST` body:

| Field                | Type   | Required | Notes                                            |
| -------------------- | ------ | -------- | ------------------------------------------------ |
| `phoneNumberId`      | string | yes      | WhatsApp Cloud `phone_number_id`                 |
| `accessToken`        | string | yes      | Graph API token (encrypted at rest, never read back) |
| `channel`            | string | no       | Defaults to `whatsapp`                           |
| `wabaId`             | string | no       | WhatsApp Business Account id                     |
| `displayPhoneNumber` | string | no       | Human-readable sender number                     |
| `graphApiVersion`    | string | no       | Per-tenant Graph API version override            |
| `locationId`         | string | no       | GHL location linkage                             |
| `status`             | enum   | no       | `active` (default) or `disabled`                 |

`tenantKey` is derived as `wa:<phoneNumberId>` (consistent with the inbound
keying) — callers never set it. Tokens are encrypted with AES-256-GCM
(`TokenCipher`) before they touch the database.

```bash
curl -X POST http://localhost:3000/v1/meta-channels \
  -H "x-webhook-secret: $WEBHOOK_SECRET" -H "content-type: application/json" \
  -d '{"phoneNumberId":"123456","accessToken":"EAAxxxxx","wabaId":"987"}'
```

## Configuration

| Env var                      | Required             | Default                     | Notes                                   |
| ---------------------------- | -------------------- | --------------------------- | --------------------------------------- |
| `META_OUTBOUND_ENABLED`      | no                   | `false`                     | Master switch for the whole feature     |
| `DATABASE_URL`               | when flag on         | —                           | `postgres://…`                          |
| `DATABASE_SSL`               | no                   | `false`                     | Set `true` for managed Postgres         |
| `META_TOKEN_ENC_KEY`         | when flag on         | —                           | 32-byte base64 key (`openssl rand -base64 32`) |
| `GRAPH_API_BASE_URL`         | no                   | `https://graph.facebook.com`|                                         |
| `GRAPH_API_VERSION`          | no                   | `v21.0`                     | Default version; overridable per tenant |
| `GRAPH_API_TIMEOUT_MS`       | no                   | `10000`                     | Per-attempt axios timeout               |
| `META_OUTBOUND_CONCURRENCY`  | no                   | `10`                        | Worker concurrency for the send queue   |
| `META_OUTBOUND_JOB_ATTEMPTS` | no                   | `5`                         | BullMQ retry attempts                   |
| `META_OUTBOUND_BACKOFF_MS`   | no                   | `2000`                      | Exponential backoff base                |

## Enabling

```bash
# 1. Configure
export META_OUTBOUND_ENABLED=true
export DATABASE_URL=postgres://user:pass@host:5432/db
export META_TOKEN_ENC_KEY=$(openssl rand -base64 32)

# 2. Create the schema
yarn migration:run

# 3. Register a tenant (see POST /v1/meta-channels above)

# 4. Run the API and the worker WITH the flag on (the worker hosts the queue
#    processor): yarn start:prod  /  yarn start:worker
```

## Pipeline overview

```
caller ──POST──► /v1/messages/whatsapp
                     │
                     ├─ buildSendBody (validate Cloud API limits) ── invalid ─► 400
                     ├─ idempotency dedup (Redis SET NX, TTL = IDEMPOTENCY_TTL_SECONDS)
                     └─ enqueue BullMQ `meta-outbound` { phoneNumberId, body }
                                          │
                                          ▼
                            MetaSendProcessor.process
                                ├─ MetaChannelRepository.findByPhoneNumberId
                                │     (missing / disabled → UnrecoverableError, no retry)
                                └─ WhatsAppCloudClient.send
                                      POST /{version}/{phone_number_id}/messages
                                      Authorization: Bearer <per-tenant token>
                                      → returns wamid (logged)
```

**Error classification** (BullMQ retry contract):

| Cloud API result                                  | Handling                          |
| ------------------------------------------------- | --------------------------------- |
| `2xx`                                             | Success — `wamid` returned/logged |
| `4xx` auth / validation / 24h re-engagement window | `UnrecoverableError` — no retry  |
| `429`, `5xx`, transient Meta codes (130429, …)    | Retried with exponential backoff  |
| network / timeout                                 | Retried                           |

## Remaining work / follow-ups

These are **not** implemented yet. None of them block sending — the feature is
usable end-to-end as documented above.

| # | Item                          | Description                                                                                                  |
| - | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1 | **Media by `id`**             | Today media is sent by public `link`. Add upload to `POST /{phone_number_id}/media` and send by media `id` (more reliable for private/large assets). |
| 2 | **`wamid` reconciliation**    | Correlate the returned `wamid` with the delivery `statuses` already captured by the inbound webhook (`meta-tenant.ts`) to track sent → delivered → read. Likely a new table + linking on `wamid`. |
| 3 | **Send status / callback**    | The send is fire-and-forget (202 + jobId, no `wamid` synchronously). Add a status lookup endpoint or a callback/webhook so callers can retrieve the `wamid` and final delivery state. |
| 4 | **Credential cache**          | `MetaChannelRepository` hits Postgres on every send. Add a short-TTL Redis cache (keyed by `phone_number_id`) with invalidation on admin upsert/delete. |
| 5 | **Meta Embedded Signup (OAuth)** | Self-serve onboarding: let a customer connect their WABA via Facebook Login, exchange the code for a long-lived token, and fetch `phone_number_id` / WABA id via the Graph API — instead of pasting a token into `POST /v1/meta-channels`. The existing `/v1/oauth/callback` stub is the seam. |
| 6 | **Generalize to Messenger / Instagram** | Send via the Messenger Send API and Instagram Messaging, reusing the `tenantKey` (`page:` / `ig:`) and the queue/worker plumbing. See [the dedicated section below](#extending-to-messenger--instagram-follow-up-6) for the full analysis. |

### Extending to Messenger & Instagram (follow-up #6)

Feasible, and the architecture was built with it in mind — but it is **not a
flag flip**. Roughly **60–70% (the plumbing) is reusable; 30–40% (per-channel
domain/mapper/client + a credential-schema generalization) is new and
non-trivial**, mostly because message types and the messaging window differ per
channel.

**Reusable as-is**

- `tenantKey` already uses the `page:<id>` / `ig:<id>` / `wa:<phone_number_id>`
  scheme (defined by the inbound `meta-tenant.ts`), so multi-channel routing has
  its key.
- `meta_channels` already has a `channel` column (today always `whatsapp`).
- The BullMQ queue + worker, retry/error classification, idempotency, the
  endpoint → service → processor shape, and the axios-client pattern are all
  channel-agnostic.
- The inbound webhook already captures all three channels.

**New work per channel**

1. **Different API.** Messenger/IG use the **Send API**
   (`POST /{version}/{page_id}/messages` with `recipient: { id: <PSID> }`), not
   WhatsApp's `/{phone_number_id}/messages`. Different endpoint and body.
2. **Different recipient.** WhatsApp = phone number (`to`); Messenger = **PSID**,
   Instagram = **IGSID** (page-scoped ids, not phone numbers).
3. **Different credentials / schema.** Messenger/IG use a **Page Access Token**
   keyed by `page_id` / `ig_id`. The table is currently WhatsApp-shaped
   (`phone_number_id UNIQUE`); it needs generalizing (a generic `external_id`,
   or `page_id`/`ig_id` columns, with `channel` discriminating).
4. **Message types do not map 1:1:**

   |                | WhatsApp Cloud        | Messenger                   | Instagram             |
   | -------------- | --------------------- | --------------------------- | --------------------- |
   | Text / media   | ✅                    | ✅                          | ✅                    |
   | Buttons        | interactive (≤3)      | button template (≤3)        | limited               |
   | Quick replies  | ❌                    | ✅ (≤13)                    | ✅                    |
   | Lists          | interactive list (≤10)| ❌ (use carousel/generic)   | ❌                    |
   | Carousel       | ❌                    | generic template            | generic (constrained) |
   | Outside 24h    | approved template     | message tags                | human agent tag       |

   So `WaOutboundMessage` does not transfer directly — each channel needs its own
   mapper + validation, and WhatsApp interactive **lists have no direct
   Messenger/IG equivalent**.

**Suggested design**

- A `ChannelSender` strategy interface (`send(creds, to, message)`), with
  `WhatsAppCloudClient` as the first implementation; add `MessengerSendClient`
  and `InstagramSendClient`. The processor picks the sender from `channel`
  (derived from the `tenantKey`).
- Generalize the credential store to key by `page_id` / `ig_id` as well as
  `phone_number_id`.
- Prefer a shared core (text / media / quick-replies) plus per-channel
  extensions over a single "universal" message type — a universal type collapses
  to the lowest common denominator and loses buttons/lists.

### Operational notes / known gaps

- **Token encryption is single-key.** `META_TOKEN_ENC_KEY` has no rotation
  story yet; rotating it makes existing `access_token_enc` rows undecryptable.
  Rotation would need a re-encrypt migration (the `v1:` payload prefix is the
  hook for versioning the scheme).
- **The worker must run with `META_OUTBOUND_ENABLED=true`**, otherwise the
  `meta-outbound` queue has no processor and jobs pile up.
