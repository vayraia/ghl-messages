import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { WebhookForwarder } from './webhook-forwarder';
import { GhlReply } from './ghl-reply';
import { FlushJobData, MessageDebouncer } from './message-debouncer';
import { WEBHOOK_FLUSH_JOB, WEBHOOK_QUEUE_TOKEN } from './webhook.tokens';

export interface FlushResult {
  ok: true;
  drained: number;
  chatStatus: number;
  ghlStatus: number;
  totalMs: number;
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

    const chat = await this.forwarder.forward({
      jobId: String(job.id),
      agentId,
      contactId,
      body: concatenated,
      receivedAt,
      requestId,
    });

    const ghl = await this.ghl.send({
      jobId: String(job.id),
      contactId,
      message: chat.message,
      type: replyChannel,
    });

    return {
      ok: true,
      drained: items.length,
      chatStatus: 200,
      ghlStatus: ghl.status,
      totalMs: Date.now() - started,
    };
  }
}
