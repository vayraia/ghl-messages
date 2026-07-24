import * as Joi from 'joi';

export interface AppEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  BODY_LIMIT: string;

  WEBHOOK_SECRET: string;

  META_APP_SECRET: string;
  META_VERIFY_TOKEN: string;

  // Outbound Meta (WhatsApp Cloud) sending. When false (default), the DB and
  // the outbound module are not wired and the vars below are optional.
  META_OUTBOUND_ENABLED: boolean;
  META_TOKEN_ENC_KEY?: string;

  DATABASE_URL?: string;
  DATABASE_SSL: boolean;

  GRAPH_API_BASE_URL: string;
  GRAPH_API_VERSION: string;
  GRAPH_API_TIMEOUT_MS: number;

  META_OUTBOUND_CONCURRENCY: number;
  META_OUTBOUND_JOB_ATTEMPTS: number;
  META_OUTBOUND_BACKOFF_MS: number;

  THROTTLE_TTL_SECONDS: number;
  THROTTLE_LIMIT: number;

  REDIS_URL: string;

  // When false, this process does NOT drain the BullMQ queues (its
  // auto-started workers are closed on boot). Set it on the HTTP/API tier so
  // it only ingests + enqueues; the dedicated worker process keeps the default
  // (true) and does the job processing.
  PROCESS_JOBS: boolean;

  WEBHOOK_WORKER_CONCURRENCY: number;
  WEBHOOK_JOB_ATTEMPTS: number;
  WEBHOOK_JOB_BACKOFF_MS: number;

  CHAT_API_URL: string;
  CHAT_API_TIMEOUT_MS: number;

  // Shared secret the chat API requires to expose per-group secrets (the
  // group's `api_key`). When set, it is sent as the `X-Group-Secrets-Key`
  // header on GET /groups/by-location/{id}. Optional: when unset (or blank),
  // the request goes out without the header, as before.
  GROUP_SECRETS_API_KEY?: string;

  // In-memory TTL (ms) for cached per-location group settings. The inbound
  // controller reads the group's debounce on every message, so caching avoids a
  // CHAT_API round-trip per message during a burst (and the flush worker reuses
  // the same cache). Trade-off: a settings change can take up to this long to
  // propagate. 0 disables caching (fetch is always live).
  GROUP_CACHE_TTL_MS: number;

  JOBS_URL: string;
  JOBS_API_TIMEOUT_MS: number;

  GHL_API_BASE_URL: string;
  GHL_API_VERSION: string;
  GHL_API_TIMEOUT_MS: number;

  // fieldKey of the contact custom field whose value, when set, overrides the
  // inbound agent_id (takes precedence over channel_agents / default_agent).
  AGENT_FIELD_KEY: string;

  MESSAGE_DEBOUNCE_MS: number;
  IDEMPOTENCY_TTL_SECONDS: number;

  // Stale-event guard for the native inbound webhook. During contact syncs GHL
  // replays past messages with their original `dateAdded`; a real inbound is
  // seconds old while a replay is hours/days/months old. When > 0, inbound
  // events older than this many seconds are dropped before enqueueing. 0
  // (default) disables the guard entirely. Recommended in prod: 600 (10 min).
  INBOUND_MAX_AGE_SECONDS: number;

  // Debug toggle: when true, POST /webhook/v1/inbound logs the full raw request
  // body (pre-whitelist) at INFO. Verbose + serializes every inbound payload,
  // so keep it off in normal operation and only flip on to capture samples.
  LOG_INBOUND_RAW: boolean;

  // When true (default), an inbound flush whose attachments include a video is
  // dropped in full (text included) before being forwarded to the AI. GHL's
  // payload can't distinguish a video from an audio (both arrive as a `.mp4`
  // URL with an empty body and a channel-only `contentType`), so the worker
  // probes each attachment's real Content-Type with a HEAD. Set to false to
  // forward videos as normal attachments.
  DROP_INBOUND_VIDEO: boolean;

  // Timeout (ms) for the per-attachment HEAD request used to classify media
  // type. Kept short since it runs inline in the worker before forwarding.
  MEDIA_HEAD_TIMEOUT_MS: number;

  // Bull Board dashboard. Off by default; when on, exposes a Basic-Auth-gated
  // queue UI at /admin/queues on the HTTP tier (never on the worker).
  BULL_BOARD_ENABLED: boolean;
  BULL_BOARD_USER?: string;
  BULL_BOARD_PASSWORD?: string;
}

export const envValidationSchema = Joi.object<AppEnv, true>({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').default('info'),
  BODY_LIMIT: Joi.string().default('1mb'),

  WEBHOOK_SECRET: Joi.string().min(16).required(),

  META_APP_SECRET: Joi.string().min(16).required(),
  META_VERIFY_TOKEN: Joi.string().min(8).required(),

  // Feature flag for outbound Meta sending. Gates the DB + outbound module in
  // app.module.ts; when off (default) the two vars below are not needed.
  META_OUTBOUND_ENABLED: Joi.boolean().default(false),
  // 32-byte AES-256-GCM key, base64-encoded. `openssl rand -base64 32`.
  META_TOKEN_ENC_KEY: Joi.string()
    .base64()
    .when('META_OUTBOUND_ENABLED', { is: true, then: Joi.required(), otherwise: Joi.optional() }),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .when('META_OUTBOUND_ENABLED', { is: true, then: Joi.required(), otherwise: Joi.optional() }),
  DATABASE_SSL: Joi.boolean().default(false),

  GRAPH_API_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('https://graph.facebook.com'),
  GRAPH_API_VERSION: Joi.string().default('v21.0'),
  GRAPH_API_TIMEOUT_MS: Joi.number().integer().min(100).default(10_000),

  META_OUTBOUND_CONCURRENCY: Joi.number().integer().min(1).default(10),
  META_OUTBOUND_JOB_ATTEMPTS: Joi.number().integer().min(1).default(2),
  META_OUTBOUND_BACKOFF_MS: Joi.number().integer().min(0).default(2000),

  THROTTLE_TTL_SECONDS: Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(600),

  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),

  PROCESS_JOBS: Joi.boolean().default(true),

  // Default tuned for the single-process deployment (one main.js does HTTP +
  // job processing). 20 saturated CPU under bursts; 6 keeps enough throughput
  // (downstream APIs are the real bottleneck) without starving HTTP ingestion.
  // Bump it back up when running a dedicated worker process.
  WEBHOOK_WORKER_CONCURRENCY: Joi.number().integer().min(1).default(6),
  WEBHOOK_JOB_ATTEMPTS: Joi.number().integer().min(1).default(2),
  WEBHOOK_JOB_BACKOFF_MS: Joi.number().integer().min(0).default(2000),

  CHAT_API_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  CHAT_API_TIMEOUT_MS: Joi.number().integer().min(100).default(15_000),
  // Optional — allowed to be empty so an unused placeholder in .env behaves
  // exactly like an absent var (no header sent).
  GROUP_SECRETS_API_KEY: Joi.string().allow('').optional(),
  GROUP_CACHE_TTL_MS: Joi.number().integer().min(0).default(60_000),

  JOBS_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  JOBS_API_TIMEOUT_MS: Joi.number().integer().min(100).default(10_000),

  GHL_API_BASE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('https://services.leadconnectorhq.com'),
  GHL_API_VERSION: Joi.string().default('2021-07-28'),
  GHL_API_TIMEOUT_MS: Joi.number().integer().min(100).default(10_000),

  AGENT_FIELD_KEY: Joi.string().default('contact.aiagent'),

  MESSAGE_DEBOUNCE_MS: Joi.number().integer().min(0).default(10_000),
  IDEMPOTENCY_TTL_SECONDS: Joi.number().integer().min(1).default(3600),

  INBOUND_MAX_AGE_SECONDS: Joi.number().integer().min(0).default(0),

  LOG_INBOUND_RAW: Joi.boolean().default(false),

  DROP_INBOUND_VIDEO: Joi.boolean().default(true),
  MEDIA_HEAD_TIMEOUT_MS: Joi.number().integer().min(100).default(5000),

  BULL_BOARD_ENABLED: Joi.boolean().default(false),
  // Credentials are required only when the dashboard is enabled, so the default
  // (disabled) config needs neither.
  BULL_BOARD_USER: Joi.string()
    .min(3)
    .when('BULL_BOARD_ENABLED', { is: true, then: Joi.required(), otherwise: Joi.optional() }),
  BULL_BOARD_PASSWORD: Joi.string()
    .min(12)
    .when('BULL_BOARD_ENABLED', { is: true, then: Joi.required(), otherwise: Joi.optional() }),
});
