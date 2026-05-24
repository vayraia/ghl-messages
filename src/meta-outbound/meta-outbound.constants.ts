/** BullMQ queue for outbound WhatsApp Cloud sends (separate from the inbound
 * `webhook-events` queue so retry/concurrency policies are independent). */
export const META_OUTBOUND_QUEUE_TOKEN = 'meta-outbound';

/** Job name for a single outbound send. */
export const META_SEND_JOB = 'meta.send';

/** DI token for the dedicated ioredis client used for send idempotency. */
export const META_OUTBOUND_REDIS_CLIENT = 'META_OUTBOUND_REDIS_CLIENT';
