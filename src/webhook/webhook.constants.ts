export const WEBHOOK_SECRET_HEADER = 'x-webhook-secret';
export const WEBHOOK_IDEMPOTENCY_HEADER = 'x-idempotency-key';
export const META_SIGNATURE_HEADER = 'x-hub-signature-256';

/**
 * Job that drains the per-(agent,contact) Redis list of accumulated message
 * fragments and forwards a single concatenated message downstream. There is
 * intentionally no per-event job — the controller only RPUSHes into the list
 * and (re)schedules a flush.
 */
export const WEBHOOK_FLUSH_JOB = 'webhook.flush';
