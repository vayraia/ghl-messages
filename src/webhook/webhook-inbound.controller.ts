import { Body, Controller, HttpCode, HttpStatus, Inject, Logger, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
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
  private readonly logRawInbound: boolean;

  constructor(
    private readonly debouncer: MessageDebouncer,
    @Inject(WEBHOOK_REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<AppEnv, true>,
  ) {
    this.idempotencyTtlSeconds = config.get('IDEMPOTENCY_TTL_SECONDS', { infer: true });
    this.logRawInbound = config.get('LOG_INBOUND_RAW', { infer: true });
  }

  @Post('inbound')
  @HttpCode(HttpStatus.OK)
  async inbound(
    @Body() body: InboundMessagePayloadDto,
    @Req() req?: Request,
  ): Promise<InboundResponse> {
    // Debug-only: log the FULL raw inbound payload (before whitelist stripping)
    // at INFO so it is visible regardless of log level. `req.body` is the
    // untransformed JSON parsed by body-parser, so it keeps every field the
    // DTO whitelist would otherwise drop (from, to, webhookId, dateAdded, …).
    // Gated behind LOG_INBOUND_RAW because it is verbose and serializes every
    // payload on the high-volume inbound path — keep it off in normal operation.
    if (this.logRawInbound) {
      this.logger.log({ rawBody: req?.body as unknown }, 'inbound webhook raw payload');
    }

    if (
      body.type !== 'InboundMessage' ||
      body.direction !== 'inbound' ||
      body.status !== 'delivered'
    ) {
      return { ok: true, skipped: 'filtered' };
    }

    // Public comments (TikTok / FB / IG) share the inbound webhook with DMs
    // but cannot reliably be answered through /conversations/messages, so
    // drop them before they hit the AI pipeline.
    if (isCommentMessage(body)) {
      return { ok: true, skipped: 'comment' };
    }

    const locationId = body.locationId?.trim();
    const contactId = body.contactId?.trim();
    const text = body.body?.trim() ?? '';
    if (!locationId || !contactId) {
      return { ok: true, skipped: 'missing_ids' };
    }

    const attachments = Array.isArray(body.attachments)
      ? body.attachments.filter((a) => typeof a === 'string' && a.length > 0)
      : [];

    // Voice notes / image-only / sticker messages arrive with empty body and
    // the real content in attachments. Drop only if BOTH are empty.
    if (!text && attachments.length === 0) {
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
      attachments: attachments.length > 0 ? attachments : undefined,
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

function isCommentMessage(body: InboundMessagePayloadDto): boolean {
  const typeString = body.messageTypeString?.toLowerCase() ?? '';
  if (typeString.endsWith('_comment')) return true;
  const type = body.messageType?.toLowerCase() ?? '';
  if (type.includes('comment')) return true;
  return false;
}
