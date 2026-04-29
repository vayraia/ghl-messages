import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { AppEnv } from '../config/env.validation';
import { WebhookPayloadDto } from './dto/webhook-payload.dto';
import { resolveReplyChannel } from './channel-resolver';
import { MessageDebouncer } from './message-debouncer';
import { WEBHOOK_REDIS_CLIENT } from './webhook.tokens';

export interface IngestResult {
  jobId: string;
  deduplicated: boolean;
  debounced: boolean;
  pendingCount: number;
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly idempotencyTtlSeconds: number;

  constructor(
    private readonly debouncer: MessageDebouncer,
    @Inject(WEBHOOK_REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<AppEnv, true>,
  ) {
    this.idempotencyTtlSeconds = config.get('IDEMPOTENCY_TTL_SECONDS', { infer: true });
  }

  async ingest(
    payload: WebhookPayloadDto,
    opts: { idempotencyKey?: string; requestId?: string },
  ): Promise<IngestResult> {
    if (opts.idempotencyKey) {
      const wasFresh = await this.redis.set(
        idempotencyKeyFor(opts.idempotencyKey),
        '1',
        'EX',
        this.idempotencyTtlSeconds,
        'NX',
      );
      if (wasFresh === null) {
        return {
          jobId: opts.idempotencyKey,
          deduplicated: true,
          debounced: false,
          pendingCount: 0,
        };
      }
    }

    const agentId = payload.agent_id ?? payload.customData?.agent_id;
    if (!agentId) {
      throw new BadRequestException(
        'agent_id is required (top level or customData.agent_id)',
      );
    }

    const body = (payload.message?.body ?? payload.customData?.message ?? '').trim();
    if (!body) {
      // No usable text — silently acknowledge so GHL stops retrying.
      this.logger.debug(
        { agentId, contactId: payload.contact_id },
        'Empty inbound message — acknowledged without enqueuing',
      );
      return { jobId: '', deduplicated: false, debounced: false, pendingCount: 0 };
    }

    const replyChannel = resolveReplyChannel(payload);

    const result = await this.debouncer.accept({
      agentId,
      contactId: payload.contact_id,
      body,
      replyChannel,
      requestId: opts.requestId,
    });

    return {
      jobId: result.jobId,
      deduplicated: false,
      debounced: result.pendingCount > 1,
      pendingCount: result.pendingCount,
    };
  }
}

function idempotencyKeyFor(key: string): string {
  return `webhook:idem:${key}`;
}
