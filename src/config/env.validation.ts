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

  WEBHOOK_WORKER_CONCURRENCY: number;
  WEBHOOK_JOB_ATTEMPTS: number;
  WEBHOOK_JOB_BACKOFF_MS: number;

  CHAT_API_URL: string;
  CHAT_API_TIMEOUT_MS: number;

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
  META_OUTBOUND_JOB_ATTEMPTS: Joi.number().integer().min(1).default(5),
  META_OUTBOUND_BACKOFF_MS: Joi.number().integer().min(0).default(2000),

  THROTTLE_TTL_SECONDS: Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(600),

  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),

  WEBHOOK_WORKER_CONCURRENCY: Joi.number().integer().min(1).default(20),
  WEBHOOK_JOB_ATTEMPTS: Joi.number().integer().min(1).default(5),
  WEBHOOK_JOB_BACKOFF_MS: Joi.number().integer().min(0).default(2000),

  CHAT_API_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required(),
  CHAT_API_TIMEOUT_MS: Joi.number().integer().min(100).default(15_000),

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
});
