# Webhook API

## `POST /v1/webhook`

Accepts a chat-style webhook event, authenticates it, debounces multiple
messages from the same `(agent_id, contact_id)` pair, and asynchronously
forwards the concatenated text to the configured chat API. The chat
reply is then sent back to the contact through GHL.

### Authentication

Every request must include the shared secret in the `x-webhook-secret`
header. The server compares it against the configured `WEBHOOK_SECRET`
using `crypto.timingSafeEqual`, so the comparison runs in constant time
and does not leak the secret via response timing.

```
x-webhook-secret: <secret-from-WEBHOOK_SECRET>
```

### Headers

| Header               | Required | Description                                                      |
| -------------------- | -------- | ---------------------------------------------------------------- |
| `x-webhook-secret`   | yes      | Shared secret for caller authentication                          |
| `x-idempotency-key`  | no       | Stable string identifying this delivery; enables inbound dedup   |
| `x-request-id`       | no       | Trace identifier; auto-generated UUID v4 if absent and echoed in the response |
| `content-type`       | yes      | `application/json`                                               |

### Request body

```json
{
  "agent_id": "ventas",
  "contact_id": "c_01HZX...",
  "message": { "body": "Hola, quería más info" },

  "first_name": "Fabio",
  "last_name": "Coronado",

  "customData": { "channel": "WhatsApp" },
  "contact": { "lastAttributionSource": { "medium": "WhatsApp" } }
}
```

| Field                                       | Type   | Required | Notes                                                       |
| ------------------------------------------- | ------ | -------- | ----------------------------------------------------------- |
| `agent_id`                                  | string | yes      | Routes the conversation to a specific agent in your chat API |
| `contact_id`                                | string | yes      | Stable id used for debounce coalescing and GHL replies       |
| `message.body`                              | string | yes¹     | Inbound user text                                            |
| `customData.message`                        | string | yes¹     | Fallback text source if `message.body` is missing            |
| `message.type`                              | string | no       | Hint for `replyChannel`                                      |
| `customData.channel`                        | string | no       | Hint for `replyChannel`                                      |
| `contact.lastAttributionSource.medium`      | string | no       | Highest-priority `replyChannel` hint                          |
| `contact.attributionSource.medium`          | string | no       | Second-priority `replyChannel` hint                           |
| `name`, `full_name`, `first_name`, `last_name` | string | no    | Accepted for backward compat — ignored. `contact_data.name` is now sourced from `GET /contacts/{id}` (`firstName`) |
| `event`, `id`, `data`                       | any    | no       | Pass-through metadata, kept for future expansion             |

¹ At least one of `message.body` / `customData.message` must yield
non-empty text. An empty body returns `202` without enqueuing.

Unknown top-level fields are rejected with `400`.

### Responses

#### `202 Accepted`

```json
{
  "accepted": true,
  "jobId": "flush_ventas_c_01H..._1714281600000-a3f1d2c4",
  "deduplicated": false,
  "debounced": false
}
```

- `jobId` — id of the delayed flush job (or the idempotency key when
  deduplicated).
- `deduplicated` — `true` when `x-idempotency-key` matched a previously
  seen delivery (TTL = `IDEMPOTENCY_TTL_SECONDS`, default 1 h).
- `debounced` — `true` when this message extended an already-pending
  flush window for the same `(agent_id, contact_id)` pair.

#### `400 Bad Request`

Returned when the body fails validation (missing `agent_id` /
`contact_id`, unknown fields, type mismatch, length limits).

#### `401 Unauthorized`

Returned when `x-webhook-secret` is missing or does not match.

#### `429 Too Many Requests`

Returned when the per-IP rate limit (`THROTTLE_LIMIT` per
`THROTTLE_TTL_SECONDS`) is exceeded.

#### `5xx`

Returned when Redis is unreachable. Providers should retry.

### Example — single message

```bash
curl -i -X POST http://localhost:3000/v1/webhook \
  -H "content-type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -H "x-idempotency-key: evt_01HZX0000000000000000001" \
  -d '{
    "agent_id": "ventas",
    "contact_id": "c_01HZX0000000000000000ABC",
    "message": { "body": "Hola, quiero información sobre brackets" },
    "contact": { "lastAttributionSource": { "medium": "WhatsApp" } }
  }'
```

### Example — debounce in action

Three messages from the same `contact_id` arriving within the debounce
window collapse into **one** call to `/chat`:

```bash
# t=0
curl -X POST http://localhost:3000/v1/webhook \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{"agent_id":"ventas","contact_id":"c1","message":{"body":"hola"}}'

# t=2s
curl -X POST http://localhost:3000/v1/webhook \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{"agent_id":"ventas","contact_id":"c1","message":{"body":"buen día"}}'

# t=5s
curl -X POST http://localhost:3000/v1/webhook \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{"agent_id":"ventas","contact_id":"c1","message":{"body":"quiero info"}}'
```

`MESSAGE_DEBOUNCE_MS` (default `10000`) milliseconds after the **last**
arrival, the worker fires a single forward:

```http
POST $CHAT_API_URL/chat
content-type: application/json
x-webhook-job-id: flush_ventas_c1_1714281605000-7af2d91c
x-webhook-received-at: 2026-04-28T12:00:00.000Z
x-request-id: <uuid>

{
  "agent_id": "ventas",
  "contact_id": "c1",
  "contact_data": {
    "ghl_token": "pit-...",
    "location_id": "loc_...",
    "name": "Fabio",
    "custom_fields": [
      { "id": "cf_1", "name": "Reprogramar Cita", "value": "https://..." }
    ]
  },
  "message": { "body": "hola\nbuen día\nquiero info" }
}
```

## Pipeline overview

```
GHL  ──POST──►  /v1/webhook
                    │
                    ├─ idempotency dedup (Redis SET NX, TTL = IDEMPOTENCY_TTL_SECONDS)
                    │
                    └─ MessageDebouncer.accept
                          ├─ RPUSH debounce:msgs:{agent}:{contact} <fragment>
                          ├─ EXPIRE 5 min
                          └─ schedule BullMQ flush (delay = MESSAGE_DEBOUNCE_MS)
                                                │
                                          (timer expires)
                                                │
                                                ▼
                                  WebhookProcessor.process
                                          ├─ drain Redis list (LRANGE + DEL atomic)
                                          ├─ GET  $GHL_API_BASE_URL/contacts/{id}   (firstName + custom fields)
                                          ├─ POST $CHAT_API_URL/chat
                                          │     body: { agent_id, contact_id, contact_data: { ghl_token, location_id, name?, custom_fields? }, message: { body, type } }
                                          │     → expects { messages: [...] }
                                          └─ POST $GHL_API_BASE_URL/conversations/messages
                                                Authorization: Bearer $GHL_API_KEY
                                                Version:       $GHL_API_VERSION
                                                body: { contactId, message, type: replyChannel }
```

### Chat API contract (`POST $CHAT_API_URL/chat`)

The forwarder POSTs:

```json
{
  "agent_id": "ventas",
  "contact_id": "c_01H...",
  "contact_data": {
    "ghl_token": "pit-...",
    "location_id": "loc_...",
    "name": "Fabio",
    "custom_fields": [
      { "id": "cf_1", "name": "Reprogramar Cita", "value": "https://..." }
    ]
  },
  "message": { "body": "hola\nbuen día", "type": "WhatsApp" }
}
```

`contact_data` always carries `ghl_token` (the location's GHL API key,
from the group's `api_key`) and `location_id` (the GHL location the
conversation belongs to). The chat API can use these to call GHL on
behalf of the location (read fields, create opportunities, etc.).

`contact_data.name` is the contact's `firstName` from
`GET $GHL_API_BASE_URL/contacts/{id}`. The forwarder fetches the contact
on every flush (regardless of whether the group has an `ai_field_id`
gate configured), so the same call serves both the AI toggle and the
name lookup. When the contact has no `firstName`, `name` is omitted from
`contact_data`.

`contact_data.custom_fields` is an array of the contact's custom fields,
each entry carrying `{ id, name, value }`. The `id` is GHL's custom-field
id, `name` is resolved from `GET $GHL_API_BASE_URL/locations/{id}/customFields`
(cached per location), and `value` is the contact's value normalized to a
string. Resolution is best-effort: if the contact has no custom fields, or
the definitions lookup fails, `custom_fields` is omitted entirely rather
than failing the job.

`message.type` is the originating channel of the inbound message, one of
`SMS`, `RCS`, `Email`, `WhatsApp`, `IG`, `FB`, `Custom`, `Live_Chat`,
`TIKTOK` (the same enum GHL accepts on `POST /conversations/messages`). It
lets the chat API know whether the message came from WhatsApp, Instagram,
Facebook, etc. It is the same channel the reply is sent back on.

Headers added by the forwarder:

| Header                  | Value                                  |
| ----------------------- | -------------------------------------- |
| `content-type`          | `application/json`                     |
| `x-webhook-job-id`      | The BullMQ flush job id                |
| `x-webhook-received-at` | ISO timestamp of the **first** message |
| `x-request-id`          | Trace identifier                       |

The chat API **must** respond with:

```json
{ "message": "the assistant reply" }
```

| Chat API response               | Result                                                                  |
| ------------------------------- | ----------------------------------------------------------------------- |
| `2xx` with non-empty `message`  | Pipeline continues to GHL                                               |
| `2xx` without `message`         | Job marked **failed without retry** (contract violation)                |
| `4xx`                           | Job marked **failed without retry**                                     |
| `5xx` / network / timeout       | Retried by BullMQ with exponential backoff (`WEBHOOK_JOB_*` env)       |

`CHAT_API_TIMEOUT_MS` is the per-attempt axios timeout.

### GHL outbound (`POST /conversations/messages`)

```json
{
  "contactId": "c_01H...",
  "message": "<reply from /chat>",
  "type": "WhatsApp"
}
```

Headers:

| Header          | Value                          |
| --------------- | ------------------------------ |
| `Authorization` | `Bearer ${GHL_API_KEY}`        |
| `Version`       | `${GHL_API_VERSION}`           |
| `Content-Type`  | `application/json`             |

The `type` field is the resolved `replyChannel`, picked from (in order):
`contact.lastAttributionSource.medium` → `contact.attributionSource.medium`
→ `customData.channel` → `message.type`. Falls back to `WhatsApp`.

A `/chat` reply element of `type: image` or `type: file` on the **WhatsApp**
channel is sent with GHL's structured `whatsapp.media` body instead of the flat
`attachments` array.

Image (`media.type: image`):

```json
{
  "contactId": "c_01H...",
  "locationId": "wfS46PMu1sOToYyj38Mq",
  "type": "WhatsApp",
  "message": "<caption>",
  "whatsapp": {
    "type": "media",
    "fromNumberId": "1130377746823770",
    "media": {
      "type": "image",
      "url": "https://.../media/abc.jpg",
      "caption": "<caption>",
      "mimeType": "image/jpeg"
    }
  }
}
```

File / document (`media.type: document`, adds `media.name`):

```json
{
  "contactId": "c_01H...",
  "locationId": "wfS46PMu1sOToYyj38Mq",
  "type": "WhatsApp",
  "message": "<caption>",
  "whatsapp": {
    "type": "media",
    "fromNumberId": "1130377746823770",
    "media": {
      "type": "document",
      "name": "cotizacion-1234.pdf",
      "url": "https://.../media/abc.pdf",
      "caption": "<caption>",
      "mimeType": "application/pdf"
    }
  }
}
```

- `fromNumberId` comes from the group's `general_settings.whatsapp_number_id`.
  When the group has no `whatsapp_number_id`, the same `whatsapp.media` body is
  sent **without** the `fromNumberId` key.
- `mimeType` is inferred from the URL extension. Images: `.png`→`image/png`,
  `.webp`→`image/webp`, `.gif`→`image/gif`, else `image/jpeg`. Documents:
  `.pdf`→`application/pdf`, `.doc/.docx`, `.xls/.xlsx`, `.ppt/.pptx`, `.txt`,
  `.csv`, `.zip`, else `application/octet-stream`.
- `media.name` (documents only) is the reply's `filename`, falling back to the
  URL basename; omitted when neither yields a value.
- This structured shape applies **only** on WhatsApp. On other channels
  (IG/FB/…) `image` and `file` replies keep the flat `message`/`attachments`
  shape — the reply's `caption` becomes `message`. `text` replies always use
  the flat shape.

Failure handling matches the chat call: 4xx → no retry, 5xx / network →
retried by BullMQ. Because both downstream calls live inside one job, a
GHL retry will re-call `/chat` as well. If you observe high duplicate
load on `/chat`, return idempotent replies based on `x-webhook-job-id`.

## `GET /v1/health/live`

Liveness probe. Returns `{ "status": "ok" }` as long as the process is
running.

## `GET /v1/health/ready`

Readiness probe. Returns `200` only when Redis responds to `PING`.
