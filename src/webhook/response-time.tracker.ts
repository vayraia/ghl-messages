import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { AppEnv } from '../config/env.validation';
import { RESPONSE_TIME_JOB, RESPONSE_TIME_QUEUE_TOKEN, WEBHOOK_REDIS_CLIENT } from './webhook.tokens';

/** How long we remember that a messageId was sent by the AI (outbound webhooks arrive within seconds). */
const AI_SENT_TTL_SECONDS = 3600;

export interface PendingInbound {
  inboundAt: number;
  messageId?: string;
  channel?: string;
}

export interface ResponseTimeJob {
  locationId: string;
  contactId: string;
  userId: string;
  channel?: string;
  inboundMessageId?: string;
  outboundMessageId: string;
  inboundAt: number;
  repliedAt: number;
}

export type AdvisorReplyOutcome = 'recorded' | 'ai_message' | 'no_pending';

/**
 * Measures how long an advisor takes to answer a contact.
 *
 * Everything on the hot path is Redis (microseconds): the AI marks the
 * messageIds it sends, inbound registers the contact's oldest unanswered
 * message, and the outbound webhook closes the clock. The only durable write
 * (Postgres) is deferred to a BullMQ job so it can never delay a webhook.
 */
@Injectable()
export class ResponseTimeTracker {
  private readonly logger = new Logger(ResponseTimeTracker.name);
  private readonly pendingTtlSeconds: number;
  private readonly aiGraceMs: number;

  constructor(
    @Inject(WEBHOOK_REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(RESPONSE_TIME_QUEUE_TOKEN) private readonly queue: Queue,
    config: ConfigService<AppEnv, true>,
  ) {
    this.pendingTtlSeconds = config.get('RESPONSE_TIME_PENDING_TTL_SECONDS', { infer: true });
    this.aiGraceMs = config.get('RESPONSE_TIME_AI_GRACE_MS', { infer: true });
  }

  /** Remembers that the AI sent this GHL messageId, so its outbound webhook isn't counted as an advisor. */
  async markAiSent(messageId: string | undefined): Promise<void> {
    if (!messageId) return;
    await this.redis.set(aiSentKey(messageId), '1', 'EX', AI_SENT_TTL_SECONDS);
  }

  /**
   * Starts the clock for a contact. NX: if an earlier message is still
   * unanswered, that one keeps the clock (response time counts from the first
   * message the advisor hasn't answered yet).
   */
  async registerInbound(input: {
    locationId: string;
    contactId: string;
    messageId?: string;
    channel?: string;
    inboundAt: number;
  }): Promise<void> {
    const value: PendingInbound = {
      inboundAt: input.inboundAt,
      messageId: input.messageId,
      channel: input.channel,
    };
    await this.redis.set(
      pendingKey(input.locationId, input.contactId),
      JSON.stringify(value),
      'EX',
      this.pendingTtlSeconds,
      'NX',
    );
  }

  /**
   * Called for every `sent`/`delivered` OutboundMessage that carries a userId.
   * Skips AI-sent messages, otherwise atomically takes the pending inbound (the
   * first of `sent`/`delivered` wins) and enqueues the Postgres write.
   */
  async recordAdvisorReply(input: {
    locationId: string;
    contactId: string;
    userId: string;
    messageId: string;
    repliedAt: number;
  }): Promise<AdvisorReplyOutcome> {
    if (await this.isAiSent(input.messageId)) return 'ai_message';

    // The outbound webhook can beat our own POST /conversations/messages
    // response, so the AI mark may not exist yet. Re-check once after a short
    // grace; this runs post-ack, so waiting costs nobody latency.
    if (this.aiGraceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.aiGraceMs));
      if (await this.isAiSent(input.messageId)) return 'ai_message';
    }

    const key = pendingKey(input.locationId, input.contactId);
    const results = await this.redis.multi().get(key).del(key).exec();
    const raw = results?.[0]?.[1];
    if (typeof raw !== 'string') return 'no_pending';

    let pending: PendingInbound;
    try {
      pending = JSON.parse(raw) as PendingInbound;
    } catch {
      return 'no_pending';
    }

    const job: ResponseTimeJob = {
      locationId: input.locationId,
      contactId: input.contactId,
      userId: input.userId,
      channel: pending.channel,
      inboundMessageId: pending.messageId,
      outboundMessageId: input.messageId,
      inboundAt: pending.inboundAt,
      repliedAt: input.repliedAt,
    };

    // BullMQ rejects custom job IDs containing ':'.
    await this.queue.add(RESPONSE_TIME_JOB, job, {
      jobId: `rt_${input.messageId.replace(/:/g, '_')}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 86400 },
    });
    this.logger.debug(
      { locationId: input.locationId, contactId: input.contactId, userId: input.userId },
      'advisor reply enqueued for response-time persistence',
    );
    return 'recorded';
  }

  private async isAiSent(messageId: string): Promise<boolean> {
    return (await this.redis.exists(aiSentKey(messageId))) === 1;
  }
}

function aiSentKey(messageId: string): string {
  return `webhook:ai-sent:${messageId}`;
}

function pendingKey(locationId: string, contactId: string): string {
  return `webhook:rt:pending:${locationId}:${contactId}`;
}
