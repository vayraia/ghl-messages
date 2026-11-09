export { WEBHOOK_FLUSH_JOB } from './webhook.constants';

/**
 * Token used by `@nestjs/bullmq` to register and inject the webhook queue.
 */
export const WEBHOOK_QUEUE_TOKEN = 'webhook-events';

/**
 * DI token for the dedicated ioredis client used by the debouncer for
 * RPUSH / LRANGE / DEL / SET-NX operations. Separate from the BullMQ
 * connection so we do not interfere with its blocking commands.
 */
export const WEBHOOK_REDIS_CLIENT = 'WEBHOOK_REDIS_CLIENT';

/**
 * Queue (and job name) that persists advisor response times to Postgres, kept
 * apart from the webhook queue so the DB write never competes with AI replies.
 */
export const RESPONSE_TIME_QUEUE_TOKEN = 'response-times';
export const RESPONSE_TIME_JOB = 'persist-response-time';
