import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { WebhookForwarder } from './webhook-forwarder';
import { GhlContactClient } from './ghl-contact-client';
import { GhlReply } from './ghl-reply';
import { GroupFetcher } from './group-fetcher';
import { InsistenceScheduler } from './insistence-scheduler';
import { FlushJobData, MessageDebouncer } from './message-debouncer';
import { WEBHOOK_FLUSH_JOB, WEBHOOK_QUEUE_TOKEN } from './webhook.tokens';

export interface FlushResult {
  ok: true;
  drained: number;
  chatStatus?: number;
  ghlStatus?: number;
  totalMs: number;
  skipped?: 'ai_disabled';
}

/**
 * Drains the per-(agent, contact) Redis list, forwards the concatenated
 * text to the chat API, then ships the chat reply to GHL. Both downstream
 * calls share a single job so retries cover the full pipeline.
 */
@Processor(WEBHOOK_QUEUE_TOKEN)
export class WebhookProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    private readonly debouncer: MessageDebouncer,
    private readonly forwarder: WebhookForwarder,
    private readonly ghl: GhlReply,
    private readonly groupFetcher: GroupFetcher,
    private readonly insistence: InsistenceScheduler,
    private readonly contactClient: GhlContactClient,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    const concurrency = this.config.get('WEBHOOK_WORKER_CONCURRENCY', { infer: true });
    this.worker.concurrency = concurrency;
  }

  async process(
    job: Job<FlushJobData, unknown, string>,
  ): Promise<FlushResult | { ok: true; drained: 0 }> {
    if (job.name !== WEBHOOK_FLUSH_JOB) {
      this.logger.warn({ name: job.name }, 'Unknown job name received');
      return { ok: true, drained: 0 };
    }

    const { agentId, contactId } = job.data;
    const started = Date.now();

    const items = await this.debouncer.drain(agentId, contactId);
    if (items.length === 0) {
      // Could happen if a more recent flush job already drained the list.
      this.logger.debug({ jobId: job.id, agentId, contactId }, 'Flush ran with empty list');
      return { ok: true, drained: 0 };
    }

    const concatenated = items.map((i) => i.body).join('\n');
    const last = items[items.length - 1];
    const replyChannel = last.replyChannel;
    const contactName = last.contactName;
    const locationId = last.locationId;
    const requestId = last.requestId;
    const receivedAt = items[0].receivedAt;

    this.logger.log(
      {
        jobId: job.id,
        agentId,
        contactId,
        attempt: job.attemptsMade + 1,
        drained: items.length,
        replyChannel,
      },
      'Flushing debounced messages',
    );

    if (!locationId) {
      this.logger.warn(
        { jobId: job.id, agentId, contactId },
        'Missing locationId — non-retryable',
      );
      throw new UnrecoverableError('locationId is required (payload.location.id)');
    }

    const group = await this.groupFetcher.fetch(locationId, String(job.id));

    if (group.aiFieldId) {
      const contact = await this.contactClient.get({
        jobId: String(job.id),
        contactId,
        apiKey: group.apiKey,
      });
      const field = contact.customFields.find((f) => f.id === group.aiFieldId!.id);
      if (field && isAiDisabled(field.value)) {
        this.logger.log(
          {
            jobId: job.id,
            agentId,
            contactId,
            locationId,
            aiFieldId: group.aiFieldId.id,
          },
          'AI gate stopped flow — ai_field is Disabled for contact',
        );
        return {
          ok: true,
          drained: items.length,
          totalMs: Date.now() - started,
          skipped: 'ai_disabled',
        };
      }
    }

    const chat = await this.forwarder.forward({
      jobId: String(job.id),
      agentId,
      contactId,
      body: concatenated,
      contactName,
      receivedAt,
      requestId,
    });

    const ghl = await this.ghl.send({
      jobId: String(job.id),
      contactId,
      message: chat.message,
      type: replyChannel,
      apiKey: group.apiKey,
    });

    try {
      await this.insistence.schedule({
        jobId: String(job.id),
        locationId,
        contactId,
        agentId,
        replyChannel,
        apiKey: group.apiKey,
        insistences: group.insistences,
      });
    } catch (err) {
      this.logger.warn(
        { jobId: job.id, err: (err as Error).message },
        'Insistence scheduling failed (swallowed)',
      );
    }

    return {
      ok: true,
      drained: items.length,
      chatStatus: 200,
      ghlStatus: ghl.status,
      totalMs: Date.now() - started,
    };
  }
}

/**
 * The custom field can store the value with mixed casing or surrounding
 * whitespace depending on how the operator configured it. We only treat
 * an explicit "disabled" (case-insensitive) as the off switch — anything
 * else, including missing or unexpected values, leaves the AI Enabled.
 */
function isAiDisabled(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.trim().toLowerCase() === 'disabled';
}
