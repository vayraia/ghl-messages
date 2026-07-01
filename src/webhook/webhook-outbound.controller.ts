import { Body, Controller, HttpCode, HttpStatus, Inject, Logger, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { AppEnv } from '../config/env.validation';
import { OutboundWebhookPayloadDto } from './dto/outbound-webhook-payload.dto';
import { ContactFieldUpdate, GhlContactClient } from './ghl-contact-client';
import { GroupFetcher } from './group-fetcher';
import { InsistenceClient } from './insistence-client';
import { WEBHOOK_REDIS_CLIENT } from './webhook.tokens';

interface OutboundResponse {
  ok: true;
  updated?: boolean;
  deduplicated?: boolean;
  skipped?: 'nothing_to_update' | 'non_blocking_user';
}

@Controller({ path: 'webhook', version: ['1'] })
export class WebhookOutboundController {
  private readonly logger = new Logger(WebhookOutboundController.name);
  private readonly idempotencyTtlSeconds: number;
  private readonly agentFieldKey: string;

  constructor(
    private readonly groupFetcher: GroupFetcher,
    private readonly contactClient: GhlContactClient,
    private readonly insistenceClient: InsistenceClient,
    @Inject(WEBHOOK_REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService<AppEnv, true>,
  ) {
    this.idempotencyTtlSeconds = config.get('IDEMPOTENCY_TTL_SECONDS', { infer: true });
    this.agentFieldKey = config.get('AGENT_FIELD_KEY', { infer: true });
  }

  @Post('outbound')
  @HttpCode(HttpStatus.OK)
  async outbound(@Body() body: OutboundWebhookPayloadDto): Promise<OutboundResponse> {
    // ────────────────────────────────────────────────────────────────────────
    // ENDPOINT DISABLED (commented out, not deleted): the /outbound webhook now
    // does NOTHING — it just acknowledges with `{ ok: true }`. The entire
    // original body is preserved below for reference / future re-enable:
    //   • type/status filter, userId check, locationId/contactId validation
    //   • Redis idempotency guard
    //   • group fetch, non-blocking-user skip, insistence cancel
    //   • contact custom-field writes (AI disable + aiagent clear)
    // To re-enable, delete this early `return` and remove the comment markers.
    // ────────────────────────────────────────────────────────────────────────
    return { ok: true };

    /*
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

    // ────────────────────────────────────────────────────────────────────────
    // TEMPORARILY DISABLED (commented out, not deleted): everything from the
    // group fetch onward — group config lookup, non-blocking-user skip,
    // insistence cancel, and the contact custom-field writes (AI disable +
    // aiagent clear). With this block off, a delivered OutboundMessage that
    // passes the filters above (steps 1–4) is acknowledged with `{ ok: true }`
    // and NO side effects: the AI is no longer disabled on human takeover and
    // pending insistences are no longer cancelled. Re-enable by removing the
    // comment markers and deleting the early `return` below.
    // ────────────────────────────────────────────────────────────────────────
    return { ok: true };
    */

    /*
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

    // Human took over → build the contact custom-field writes for a single PUT:
    //   1. disable the AI gate (aiFieldId → "Disabled"), when configured.
    //   2. clear the per-contact agent override (aiagent → ""), so the next
    //      inbound message falls back to the channel/default agent.
    const fields: ContactFieldUpdate[] = [];

    if (group.aiFieldId) {
      fields.push({ id: group.aiFieldId.id, key: group.aiFieldId.key, value: 'Disabled' });
    } else {
      this.logger.debug(
        { jobId, locationId, contactId },
        'Group has no ai_field_id configured — skipping AI disable',
      );
    }

    const agentClear = await this.buildAgentClearField(jobId, locationId, group.apiKey);
    if (agentClear) fields.push(agentClear);

    if (fields.length === 0) {
      this.logger.debug(
        { jobId, locationId, contactId },
        'Nothing to update — no ai_field_id and no aiagent field resolved',
      );
      return { ok: true, skipped: 'nothing_to_update' };
    }

    try {
      await this.contactClient.updateContactFields({
        jobId,
        contactId,
        apiKey: group.apiKey,
        fields,
      });
      return { ok: true, updated: true };
    } catch (err) {
      if (err instanceof UnrecoverableError) {
        this.logger.warn(
          { jobId, contactId, err: err.message },
          'Outbound contact update failed permanently — swallowed',
        );
        return { ok: true };
      }
      throw err;
    }
    */
  }

  /**
   * Resolves the `aiagent` (AGENT_FIELD_KEY) field for this location and returns
   * a write that clears it (empty value). The PUT is unconditional — a clear
   * over an already-empty field is idempotent, so we don't GET the contact to
   * check first. Best-effort: if the field definitions can't be fetched or the
   * key isn't defined for this location, returns `undefined` (nothing to clear).
   * The defs are cached per location, shared with the inbound enrichment.
   */
  private async buildAgentClearField(
    jobId: string,
    locationId: string,
    apiKey: string,
  ): Promise<ContactFieldUpdate | undefined> {
    try {
      const defs = await this.contactClient.listFieldDefs({ jobId, locationId, apiKey });
      const id = defs.keyToId.get(this.agentFieldKey.trim().toLowerCase());
      if (!id) {
        this.logger.debug(
          { jobId, locationId, agentFieldKey: this.agentFieldKey },
          'aiagent field not defined for location — skipping clear',
        );
        return undefined;
      }
      return { id, key: this.agentFieldKey, value: '' };
    } catch (err) {
      this.logger.warn(
        { jobId, locationId, err: (err as Error).message },
        'aiagent field def resolution failed — skipping clear',
      );
      return undefined;
    }
  }
}

function outboundIdempotencyKey(messageId: string): string {
  return `webhook:outbound:idem:${messageId}`;
}
