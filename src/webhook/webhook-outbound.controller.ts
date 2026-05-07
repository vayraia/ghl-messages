import { Body, Controller, HttpCode, HttpStatus, Inject, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { AppEnv } from '../config/env.validation';
import { OutboundWebhookPayloadDto } from './dto/outbound-webhook-payload.dto';
import { GhlContactClient } from './ghl-contact-client';
import { GroupFetcher } from './group-fetcher';
import { InsistenceClient } from './insistence-client';
import { WEBHOOK_REDIS_CLIENT } from './webhook.tokens';

interface OutboundResponse {
  ok: true;
  updated?: boolean;
  deduplicated?: boolean;
  skipped?: 'no_ai_field_id' | 'non_blocking_user';
}

@Controller({ path: 'webhook', version: ['1'] })
export class WebhookOutboundController {
  private readonly logger = new Logger(WebhookOutboundController.name);
  private readonly idempotencyTtlSeconds: number;

  constructor(
    private readonly groupFetcher: GroupFetcher,
    private readonly contactClient: GhlContactClient,
    private readonly insistenceClient: InsistenceClient,
    @Inject(WEBHOOK_REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<AppEnv, true>,
  ) {
    this.idempotencyTtlSeconds = config.get('IDEMPOTENCY_TTL_SECONDS', { infer: true });
  }

  @Post('outbound')
  @HttpCode(HttpStatus.OK)
  async outbound(@Body() body: OutboundWebhookPayloadDto): Promise<OutboundResponse> {
    this.logger.log(`outbound payload: ${JSON.stringify(body)}`);

    if (body.type !== 'OutboundMessage' || body.status !== 'delivered') {
      return { ok: true };
    }

    if (!body.userId) {
      this.logger.debug(
        { messageId: body.messageId, contactId: body.contactId },
        'No userId on delivered OutboundMessage — skipping AI disable',
      );
      return { ok: true };
    }

    const locationId = body.locationId?.trim();
    const contactId = body.contactId?.trim();
    if (!locationId || !contactId) {
      this.logger.warn(
        { messageId: body.messageId },
        'Missing locationId or contactId on delivered OutboundMessage — skipping',
      );
      return { ok: true };
    }

    if (body.messageId) {
      const wasFresh = await this.redis.set(
        outboundIdempotencyKey(body.messageId),
        '1',
        'EX',
        this.idempotencyTtlSeconds,
        'NX',
      );
      if (wasFresh === null) {
        return { ok: true, deduplicated: true };
      }
    }

    const jobId = body.messageId ?? `${contactId}:${locationId}`;

    let group;
    try {
      group = await this.groupFetcher.fetch(locationId, jobId);
    } catch (err) {
      if (err instanceof UnrecoverableError) {
        this.logger.warn(
          { jobId, contactId, err: err.message },
          'Group fetch failed permanently — swallowed',
        );
        return { ok: true };
      }
      throw err;
    }

    // Non-blocking users: this GHL user replied manually but the group config
    // says they should NOT stop the AI. Skip both insistence cancel and AI
    // field disable so the AI keeps running.
    if (group.nonBlockingUsers?.some((u) => u.id === body.userId)) {
      this.logger.debug(
        { jobId, contactId, userId: body.userId },
        'userId in non_blocking_users — skipping cancel + disable',
      );
      return { ok: true, skipped: 'non_blocking_user' };
    }

    // Human took over — cancel any pending insistences for this contact.
    // Fire-and-forget: client already swallows non-2xx and transport errors,
    // and we wrap in try/catch as defense-in-depth so it never aborts
    // the disable-AI step that follows.
    try {
      await this.insistenceClient.cancel({ jobId, contactId });
    } catch (err) {
      this.logger.warn(
        { jobId, contactId, err: (err as Error).message },
        'Insistence cancel threw unexpectedly — swallowed',
      );
    }

    if (!group.aiFieldId) {
      this.logger.debug(
        { jobId, locationId, contactId },
        'Group has no ai_field_id configured — skipping',
      );
      return { ok: true, skipped: 'no_ai_field_id' };
    }

    try {
      await this.contactClient.disableAiField({
        jobId,
        contactId,
        apiKey: group.apiKey,
        aiField: group.aiFieldId,
      });
      return { ok: true, updated: true };
    } catch (err) {
      if (err instanceof UnrecoverableError) {
        this.logger.warn(
          { jobId, contactId, err: err.message },
          'Outbound disable-AI failed permanently — swallowed',
        );
        return { ok: true };
      }
      throw err;
    }
  }
}

function outboundIdempotencyKey(messageId: string): string {
  return `webhook:outbound:idem:${messageId}`;
}
