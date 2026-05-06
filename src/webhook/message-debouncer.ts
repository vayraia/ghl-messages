import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import { AppEnv } from '../config/env.validation';
import { ReplyChannel } from './channel-resolver';
import { WEBHOOK_FLUSH_JOB, WEBHOOK_QUEUE_TOKEN, WEBHOOK_REDIS_CLIENT } from './webhook.tokens';

export type FlushSource = 'workflow' | 'inbound';

/** Each queued message fragment stored as JSON in the Redis list. */
export interface DebouncedMessage {
  body: string;
  replyChannel: ReplyChannel;
  contactName?: string;
  locationId?: string;
  requestId: string | undefined;
  receivedAt: string;
}

/**
 * Job payload for the flush worker.
 *
 * `debounceKey` is the logical key the messages were grouped under:
 *  - workflow source: the `agentId` (kept identical to legacy behavior).
 *  - inbound source: `loc:${locationId}` (agentId is not yet known at
 *    enqueue time and is resolved by the processor from the group's
 *    `general_settings.default_agent`).
 *
 * `agentId` is only set for the workflow source (where the controller
 * already knows it). For the inbound source the processor derives it.
 *
 * `locationId` is only set for the inbound source (so the processor can
 * fetch the group without inspecting the items).
 */
export interface FlushJobData {
  debounceKey: string;
  contactId: string;
  source: FlushSource;
  agentId?: string;
  locationId?: string;
}

export interface AcceptResult {
  jobId: string;
  pendingCount: number;
}

const LIST_TTL_SECONDS = 5 * 60;

/**
 * Coalesces multiple inbound messages from the same logical (debounceKey, contact) pair
 * into a single downstream invocation.
 *
 * - `accept` RPUSHes the fragment into a Redis list and schedules a fresh
 *   delayed BullMQ flush job. Any previously-scheduled flush job for that
 *   pair is cancelled (best effort) so the timer resets, just like a
 *   `clearTimeout` + `setTimeout` would in-process.
 * - `drain` atomically snapshots and clears the list. The flush worker
 *   calls this on activation. If the list is empty the worker is a no-op.
 *
 * The flush jobId carries a unique suffix per scheduling so back-to-back
 * arrivals never collide with a finished or failed job that BullMQ is
 * still keeping around for bookkeeping.
 */
@Injectable()
export class MessageDebouncer {
  private readonly logger = new Logger(MessageDebouncer.name);
  private readonly debounceMs: number;
  private readonly attempts: number;
  private readonly backoffMs: number;

  constructor(
    @InjectQueue(WEBHOOK_QUEUE_TOKEN) private readonly queue: Queue<FlushJobData>,
    @Inject(WEBHOOK_REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<AppEnv, true>,
  ) {
    this.debounceMs = config.get('MESSAGE_DEBOUNCE_MS', { infer: true });
    this.attempts = config.get('WEBHOOK_JOB_ATTEMPTS', { infer: true });
    this.backoffMs = config.get('WEBHOOK_JOB_BACKOFF_MS', { infer: true });
  }

  async accept(input: {
    debounceKey: string;
    contactId: string;
    source: FlushSource;
    agentId?: string;
    locationId?: string;
    body: string;
    replyChannel: ReplyChannel;
    contactName?: string;
    requestId: string | undefined;
  }): Promise<AcceptResult> {
    const listKey = listKeyFor(input.debounceKey, input.contactId);
    const flushKey = flushKeyFor(input.debounceKey, input.contactId);

    const item: DebouncedMessage = {
      body: input.body,
      replyChannel: input.replyChannel,
      contactName: input.contactName,
      locationId: input.locationId,
      requestId: input.requestId,
      receivedAt: new Date().toISOString(),
    };

    // RPUSH + EXPIRE in one round-trip. EXPIRE is reset on every push so an
    // active conversation never lets the list expire.
    const tx = this.redis.multi();
    tx.rpush(listKey, JSON.stringify(item));
    tx.expire(listKey, LIST_TTL_SECONDS);
    const results = await tx.exec();
    const pushResult = results?.[0] as [Error | null, number] | undefined;
    const pendingCount = pushResult && !pushResult[0] ? pushResult[1] : 0;

    // Cancel any previous still-delayed flush job (best effort).
    const previousJobId = await this.redis.get(flushKey);
    if (previousJobId) {
      try {
        const prev = await this.queue.getJob(previousJobId);
        if (prev) {
          await prev.remove();
        }
      } catch (err) {
        // Job may already be active or have been processed — that's fine,
        // the next flush will pick up the new fragment from the list.
        this.logger.debug(
          { previousJobId, msg: (err as Error).message },
          'Could not remove previous flush job',
        );
      }
    }

    // BullMQ rejects custom job IDs containing ':', so we sanitize any colon
    // that the inbound `loc:<id>` debounceKey carries.
    const safeDebounceKey = input.debounceKey.replace(/:/g, '_');
    const newJobId = `flush_${safeDebounceKey}_${input.contactId}_${Date.now()}-${randomUUID().slice(0, 8)}`;

    await this.queue.add(
      WEBHOOK_FLUSH_JOB,
      {
        debounceKey: input.debounceKey,
        contactId: input.contactId,
        source: input.source,
        agentId: input.agentId,
        locationId: input.locationId,
      },
      {
        jobId: newJobId,
        delay: this.debounceMs,
        attempts: this.attempts,
        backoff: { type: 'exponential', delay: this.backoffMs },
        removeOnComplete: true,
        removeOnFail: { age: 86_400 },
      },
    );

    await this.redis.set(flushKey, newJobId, 'EX', LIST_TTL_SECONDS);

    return { jobId: newJobId, pendingCount };
  }

  async drain(debounceKey: string, contactId: string): Promise<DebouncedMessage[]> {
    const listKey = listKeyFor(debounceKey, contactId);
    const flushKey = flushKeyFor(debounceKey, contactId);

    const tx = this.redis.multi();
    tx.lrange(listKey, 0, -1);
    tx.del(listKey);
    tx.del(flushKey);
    const results = await tx.exec();
    const rangeResult = results?.[0] as [Error | null, string[]] | undefined;
    const raw = rangeResult && !rangeResult[0] ? rangeResult[1] : [];

    const items: DebouncedMessage[] = [];
    for (const entry of raw) {
      try {
        items.push(JSON.parse(entry) as DebouncedMessage);
      } catch {
        this.logger.warn({ entry }, 'Discarding malformed debounce entry');
      }
    }
    return items;
  }
}

function listKeyFor(debounceKey: string, contactId: string): string {
  return `debounce:msgs:${debounceKey}:${contactId}`;
}

function flushKeyFor(debounceKey: string, contactId: string): string {
  return `debounce:flush:${debounceKey}:${contactId}`;
}
