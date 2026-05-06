import { Body, Controller, HttpCode, HttpStatus, Inject, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { AppEnv } from '../config/env.validation';
import { resolveInboundChannel } from './channel-resolver';
import { InboundMessagePayloadDto } from './dto/inbound-message-payload.dto';
import { MessageDebouncer } from './message-debouncer';
import { WEBHOOK_REDIS_CLIENT } from './webhook.tokens';

interface InboundResponse {
  ok: true;
  jobId?: string;
  debounced?: boolean;
  deduplicated?: boolean;
  skipped?: string;
}

/**
 * Endpoint for the native GHL `InboundMessage` webhook subscription.
 *
 * Filters down to delivered inbound messages, deduplicates by `messageId`,
 * and pushes the fragment into the shared debouncer keyed by
 * `loc:<locationId>` (the agentId is unknown at this point — it is resolved
 * by the processor from the group's `general_settings.default_agent`).
 */
@Controller({ path: 'webhook', version: ['1'] })
export class WebhookInboundController {
  private readonly logger = new Logger(WebhookInboundController.name);
  private readonly idempotencyTtlSeconds: number;

  constructor(
    private readonly debouncer: MessageDebouncer,
    @Inject(WEBHOOK_REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<AppEnv, true>,
  ) {
    this.idempotencyTtlSeconds = config.get('IDEMPOTENCY_TTL_SECONDS', { infer: true });
  }

  @Post('inbound')
  @HttpCode(HttpStatus.OK)
  async inbound(@Body() body: InboundMessagePayloadDto): Promise<InboundResponse> {
    this.logger.log(`inbound raw body: ${JSON.stringify(body)}`);

    if (
      body.type !== 'InboundMessage' ||
      body.direction !== 'inbound' ||
      body.status !== 'delivered'
    ) {
      return { ok: true, skipped: 'filtered' };
    }

    const locationId = body.locationId?.trim();
    const contactId = body.contactId?.trim();
    const text = body.body?.trim();
    if (!locationId || !contactId) {
      return { ok: true, skipped: 'missing_ids' };
    }
    if (!text) {
      return { ok: true, skipped: 'empty_body' };
    }

    if (body.messageId) {
      const wasFresh = await this.redis.set(
        inboundIdempotencyKey(body.messageId),
        '1',
        'EX',
        this.idempotencyTtlSeconds,
        'NX',
      );
      if (wasFresh === null) {
        return { ok: true, deduplicated: true };
      }
    }

    const replyChannel = resolveInboundChannel(body);

    const result = await this.debouncer.accept({
      debounceKey: `loc:${locationId}`,
      source: 'inbound',
      contactId,
      locationId,
      body: text,
      replyChannel,
      requestId: body.messageId,
    });

    return {
      ok: true,
      jobId: result.jobId,
      debounced: result.pendingCount > 1,
    };
  }
}

function inboundIdempotencyKey(messageId: string): string {
  return `webhook:inbound:idem:${messageId}`;
}
