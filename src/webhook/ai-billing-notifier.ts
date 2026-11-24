import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { AI_BILLING_JOB, AI_BILLING_QUEUE_TOKEN } from './webhook.tokens';

export interface AiBillingEvent {
  locationId: string;
  contactId: string;
  jobId: string;
  occurredAt: string;
}

/**
 * Tells `ai` that the AI just answered a contact, so it can count the contact for
 * the month (one charge per contact and month, decided on the `ai` side from the
 * group's settings). The event goes through a BullMQ queue so the HTTP call to
 * `ai` can never delay or fail a reply; it retries on its own.
 *
 * Off unless `AI_SERVICE_API_KEY` is set (the key `ai` requires on its
 * service-to-service routes).
 */
@Injectable()
export class AiBillingNotifier {
  private readonly logger = new Logger(AiBillingNotifier.name);
  private readonly enabled: boolean;

  constructor(
    @InjectQueue(AI_BILLING_QUEUE_TOKEN) private readonly queue: Queue,
    config: ConfigService<AppEnv, true>,
  ) {
    this.enabled = Boolean(config.get('AI_SERVICE_API_KEY', { infer: true })?.trim());
  }

  /** Best-effort: never throws. Call only after at least one message of the reply was accepted by GHL. */
  async notifyReply(input: {
    locationId: string;
    contactId: string;
    jobId: string;
  }): Promise<void> {
    if (!this.enabled) return;
    const event: AiBillingEvent = { ...input, occurredAt: new Date().toISOString() };
    try {
      // BullMQ rejects custom job IDs containing ':'.
      await this.queue.add(AI_BILLING_JOB, event, {
        jobId: `abe_${input.jobId}_${input.contactId}`.replace(/:/g, '_'),
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * 86400 },
      });
    } catch (err) {
      this.logger.warn(
        { jobId: input.jobId, contactId: input.contactId, err: (err as Error).message },
        'could not enqueue the AI billing event (ignored)',
      );
    }
  }
}
