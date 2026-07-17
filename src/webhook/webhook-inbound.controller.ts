import { Body, Controller, HttpCode, HttpStatus, Inject, Logger, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { Redis } from 'ioredis';
import { AppEnv } from '../config/env.validation';
import { resolveInboundChannel } from './channel-resolver';
import { InboundMessagePayloadDto } from './dto/inbound-message-payload.dto';
import { GroupFetcher } from './group-fetcher';
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
  private readonly maxInboundAgeSeconds: number;

  constructor(
    private readonly debouncer: MessageDebouncer,
    private readonly groupFetcher: GroupFetcher,
    @Inject(WEBHOOK_REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<AppEnv, true>,
  ) {
    this.idempotencyTtlSeconds = config.get('IDEMPOTENCY_TTL_SECONDS', { infer: true });
    this.logRawInbound = config.get('LOG_INBOUND_RAW', { infer: true });
    this.maxInboundAgeSeconds = config.get('INBOUND_MAX_AGE_SECONDS', { infer: true });
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

    // Stickers are noise for the AI flow — a contact reacting with a sticker
    // isn't asking anything. WhatsApp delivers them as `.webp` attachments with
    // no text body (real photos are converted to `.jpeg`), so drop a message
    // that is sticker-only: empty text AND every attachment is a `.webp`. A
    // `.webp` sent alongside text, or mixed with a non-webp attachment, is
    // treated as a real image and processed normally.
    if (!text && attachments.every(isStickerAttachment)) {
      return { ok: true, skipped: 'sticker' };
    }

    // Stale-event guard. During contact syncs GHL replays past messages with
    // their original `dateAdded` (creation time on GHL's side). A genuine
    // inbound is seconds old; a sync replay is hours/days/months old. Drop
    // events older than INBOUND_MAX_AGE_SECONDS so they never reach the AI
    // flow. Placed before the idempotency SET NX so a stale replay doesn't burn
    // a dedup key. Fail-open: skip the check when the guard is off (<= 0), when
    // `dateAdded` is missing/unparseable, or when it is dated in the future
    // (clock skew) — better to answer a rare stale message than drop a real one.
    if (this.maxInboundAgeSeconds > 0 && body.dateAdded) {
      const addedMs = Date.parse(body.dateAdded);
      if (!Number.isNaN(addedMs)) {
        const ageSeconds = (Date.now() - addedMs) / 1000;
        if (ageSeconds > this.maxInboundAgeSeconds) {
          this.logger.log(
            { contactId, dateAdded: body.dateAdded, ageSeconds: Math.round(ageSeconds) },
            'inbound skipped: stale event (likely GHL sync replay)',
          );
          return { ok: true, skipped: 'stale' };
        }
      }
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

    // Per-group debounce override. The group is fetched (and cached by
    // GroupFetcher) here so a burst of messages shares one CHAT_API round-trip
    // and the flush worker reuses the same cache. Fail-open: any fetch error
    // falls back to the global MESSAGE_DEBOUNCE_MS — the flush will re-fetch and
    // surface a real config error there, so we don't fail the webhook here.
    let delayOverride: number | undefined;
    try {
      const group = await this.groupFetcher.fetch(locationId, body.messageId ?? 'inbound');
      delayOverride = group.debounceMs;
    } catch (err) {
      this.logger.debug(
        { locationId, msg: (err as Error).message },
        'group fetch for debounce override failed — using default',
      );
    }

    const result = await this.debouncer.accept({
      debounceKey: `loc:${locationId}`,
      source: 'inbound',
      contactId,
      locationId,
      body: text,
      replyChannel,
      attachments: attachments.length > 0 ? attachments : undefined,
      requestId: body.messageId,
      delayOverride,
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

function isStickerAttachment(url: string): boolean {
  // Match a `.webp` extension before any query string / fragment
  // (e.g. https://cdn.ghl.com/abc.webp?token=…).
  return /\.webp(?:[?#]|$)/i.test(url);
}

function isCommentMessage(body: InboundMessagePayloadDto): boolean {
  const typeString = body.messageTypeString?.toLowerCase() ?? '';
  if (typeString.endsWith('_comment')) return true;
  const type = body.messageType?.toLowerCase() ?? '';
  if (type.includes('comment')) return true;
  return false;
}
