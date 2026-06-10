import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { resolveAgentForChannel } from './channel-resolver';
import { ChatMessage, WebhookForwarder } from './webhook-forwarder';
import {
  GhlContactClient,
  buildNamedCustomFields,
  NamedCustomField,
} from './ghl-contact-client';
import {
  GhlReply,
  inferImageMimeType,
  inferDocumentMimeType,
  basenameFromUrl,
} from './ghl-reply';
import { GroupFetcher } from './group-fetcher';
import { InsistenceClient } from './insistence-client';
import { FlushJobData, MessageDebouncer } from './message-debouncer';
import { WEBHOOK_FLUSH_JOB, WEBHOOK_QUEUE_TOKEN } from './webhook.tokens';

/**
 * Pacing between consecutive GHL sends when the chat reply contains
 * multiple messages — GHL doesn't guarantee ordering on rapid-fire posts,
 * so we space them out client-side.
 */
const CHAT_MESSAGE_DELAY_MS = 2500;

export interface FlushResult {
  ok: true;
  drained: number;
  chatStatus?: number;
  ghlStatus?: number;
  totalMs: number;
  skipped?: 'ai_disabled' | 'no_default_agent';
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
    private readonly insistence: InsistenceClient,
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

    const { debounceKey, contactId, source } = job.data;
    const started = Date.now();

    const items = await this.debouncer.drain(debounceKey, contactId);
    if (items.length === 0) {
      // Could happen if a more recent flush job already drained the list.
      this.logger.debug({ jobId: job.id, debounceKey, contactId }, 'Flush ran with empty list');
      return { ok: true, drained: 0 };
    }

    const concatenated = items.map((i) => i.body).join('\n');
    const attachments = items.flatMap((i) => i.attachments ?? []);
    const last = items[items.length - 1];
    const replyChannel = last.replyChannel;
    // For inbound source the locationId is on job.data (agentId unknown at
    // enqueue time); for workflow source the items carry it.
    const locationId = job.data.locationId ?? last.locationId;
    const requestId = last.requestId;
    const receivedAt = items[0].receivedAt;

    if (!locationId) {
      this.logger.warn(
        { jobId: job.id, debounceKey, contactId },
        'Missing locationId — non-retryable',
      );
      throw new UnrecoverableError('locationId is required');
    }

    const group = await this.groupFetcher.fetch(locationId, String(job.id));

    // Inbound flushes resolve agentId from the group: per-channel override
    // (`channel_agents.<channel>`) takes precedence over `default_agent`.
    // If neither is configured for this channel, drop silently — there is
    // no agent to forward to.
    let agentId: string;
    if (source === 'inbound') {
      const channelAgent = resolveAgentForChannel(group.channelAgents, replyChannel);
      const resolved = channelAgent ?? group.defaultAgent;
      if (!resolved) {
        this.logger.log(
          { jobId: job.id, locationId, contactId, replyChannel },
          'Inbound flush skipped — no channel_agent or default_agent configured',
        );
        return {
          ok: true,
          drained: items.length,
          totalMs: Date.now() - started,
          skipped: 'no_default_agent',
        };
      }
      agentId = resolved;
    } else {
      if (!job.data.agentId) {
        throw new UnrecoverableError('agentId missing for workflow flush');
      }
      agentId = job.data.agentId;
    }

    this.logger.log(
      {
        jobId: job.id,
        agentId,
        contactId,
        source,
        attempt: job.attemptsMade + 1,
        drained: items.length,
        replyChannel,
      },
      'Flushing debounced messages',
    );

    const contact = await this.contactClient.get({
      jobId: String(job.id),
      contactId,
      apiKey: group.apiKey,
    });

    if (group.aiFieldId) {
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

    // Resolve the contact's custom fields (id → value) into { id, name, value }
    // entries for the chat API. Best-effort: if the definitions can't be
    // fetched we forward without `custom_fields` rather than fail the job.
    let customFields: NamedCustomField[] | undefined;
    if (contact.customFields.length > 0) {
      try {
        const defs = await this.contactClient.listCustomFields({
          jobId: String(job.id),
          locationId,
          apiKey: group.apiKey,
        });
        const named = buildNamedCustomFields(contact.customFields, defs);
        if (named.length > 0) {
          customFields = named;
        }
      } catch (err) {
        this.logger.warn(
          { jobId: job.id, locationId, contactId, err: (err as Error).message },
          'Custom field name resolution failed — forwarding without custom_fields',
        );
      }
    }

    const chat = await this.forwarder.forward({
      jobId: String(job.id),
      agentId,
      contactId,
      locationId,
      apiKey: group.apiKey,
      body: concatenated,
      channel: replyChannel,
      contactName: contact.firstName,
      customFields,
      attachments: attachments.length > 0 ? attachments : undefined,
      receivedAt,
      requestId,
    });

    let lastStatus: number | undefined;
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < chat.messages.length; i++) {
      if (i > 0) await sleep(CHAT_MESSAGE_DELAY_MS);
      const message = chat.messages[i];
      try {
        // WhatsApp image/file replies use GHL's structured `whatsapp.media`
        // body (with the group's `fromNumberId` when available); every other
        // case uses the flat message/attachments shape.
        let result;
        if (message.type === 'image' && replyChannel === 'WhatsApp') {
          const caption = message.caption ?? '';
          result = await this.ghl.send({
            jobId: String(job.id),
            contactId,
            message: caption,
            type: replyChannel,
            apiKey: group.apiKey,
            locationId,
            whatsappMedia: {
              type: 'image',
              url: message.url,
              caption,
              mimeType: inferImageMimeType(message.url),
              fromNumberId: group.whatsappNumberId,
            },
          });
        } else if (message.type === 'file' && replyChannel === 'WhatsApp') {
          const caption = message.caption ?? '';
          result = await this.ghl.send({
            jobId: String(job.id),
            contactId,
            message: caption,
            type: replyChannel,
            apiKey: group.apiKey,
            locationId,
            whatsappMedia: {
              type: 'document',
              name: message.filename ?? basenameFromUrl(message.url),
              url: message.url,
              caption,
              mimeType: inferDocumentMimeType(message.url),
              fromNumberId: group.whatsappNumberId,
            },
          });
        } else {
          const payload = toGhlPayload(message);
          result = await this.ghl.send({
            jobId: String(job.id),
            contactId,
            message: payload.message,
            type: replyChannel,
            apiKey: group.apiKey,
            attachments: payload.attachments,
          });
        }
        sent++;
        lastStatus = result.status;
      } catch (err) {
        failed++;
        // Best-effort: a mid-sequence failure must NOT bubble up, otherwise
        // BullMQ would retry the whole job and re-send the messages that
        // already landed before the failure. Log and continue.
        this.logger.warn(
          {
            jobId: job.id,
            contactId,
            index: i,
            total: chat.messages.length,
            messageType: message.type,
            err: (err as Error).message,
          },
          'GHL send failed mid-sequence — continuing with remaining messages',
        );
      }
    }

    // Only schedule follow-ups if the bot actually said something. If every
    // send failed there is nothing for the contact to "insist" against.
    if (sent > 0) {
      try {
        await this.insistence.schedule({
          jobId: String(job.id),
          locationId,
          contactId,
          agentId,
          replyChannel,
          apiKey: group.apiKey,
          insistences: group.insistences,
          schedule: group.insistenceSchedule,
        });
      } catch (err) {
        this.logger.warn(
          { jobId: job.id, err: (err as Error).message },
          'Insistence scheduling failed (swallowed)',
        );
      }
    } else {
      this.logger.warn(
        { jobId: job.id, contactId, failed, total: chat.messages.length },
        'All GHL sends failed — skipping insistence schedule',
      );
    }

    return {
      ok: true,
      drained: items.length,
      chatStatus: 200,
      ghlStatus: lastStatus,
      totalMs: Date.now() - started,
    };
  }
}

interface GhlSendPayload {
  message: string;
  attachments?: string[];
}

/**
 * Maps a single `/chat` reply element to the body fields used by
 * `POST /conversations/messages` on the flat (non-WhatsApp-media) path. Both
 * `image` and `file` use their `caption` as the message body so it renders as
 * a caption in the receiving channel; the URL goes in `attachments`.
 */
function toGhlPayload(m: ChatMessage): GhlSendPayload {
  switch (m.type) {
    case 'text':
      return { message: m.content };
    case 'image':
      return { message: m.caption ?? '', attachments: [m.url] };
    case 'file':
      return { message: m.caption ?? '', attachments: [m.url] };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
