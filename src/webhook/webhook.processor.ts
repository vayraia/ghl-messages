import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { isAiAvailable } from './ai-schedule';
import { resolveAgentForChannel } from './channel-resolver';
import { ChatMessage, WebhookForwarder } from './webhook-forwarder';
import {
  GhlContactClient,
  buildNamedCustomFields,
  resolveFieldValueByKey,
  NamedCustomField,
  AssignedUser,
  GetContactResult,
} from './ghl-contact-client';
import { GhlReply, inferImageMimeType, inferDocumentMimeType, basenameFromUrl } from './ghl-reply';
import { AttachmentClassifier } from './attachment-classifier';
import { GroupFetcher } from './group-fetcher';
import { InsistenceClient } from './insistence-client';
import { DebouncedMessage, FlushJobData, MessageDebouncer } from './message-debouncer';
import { WEBHOOK_FLUSH_JOB, WEBHOOK_QUEUE_TOKEN } from './webhook.tokens';

/**
 * Pacing between consecutive GHL sends when the chat reply contains
 * multiple messages — GHL doesn't guarantee ordering on rapid-fire posts,
 * so we space them out client-side.
 */
const CHAT_MESSAGE_DELAY_MS = 2500;

/**
 * Contact tag that hard-stops the AI flow. When the GHL contact carries this
 * tag, the flush is skipped entirely (no agent resolution, no forward). Matched
 * case-insensitively against the contact's normalized tags.
 */
const AI_DISABLE_TAG = 'desactivar ia';

export interface FlushResult {
  ok: true;
  drained: number;
  chatStatus?: number;
  ghlStatus?: number;
  totalMs: number;
  skipped?: 'ai_disabled' | 'ai_disabled_tag' | 'no_default_agent' | 'ai_off_hours' | 'video';
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
    private readonly classifier: AttachmentClassifier,
    private readonly groupFetcher: GroupFetcher,
    private readonly insistence: InsistenceClient,
    private readonly contactClient: GhlContactClient,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    // Ingest-only tiers (PROCESS_JOBS=false, e.g. the HTTP/API process) close
    // the auto-started worker so its event loop isn't competing with job
    // processing. The dedicated worker process keeps the default and drains.
    if (!this.config.get('PROCESS_JOBS', { infer: true })) {
      await this.worker.close();
      this.logger.log('PROCESS_JOBS=false — webhook worker closed (ingest-only process)');
      return;
    }
    this.worker.concurrency = this.config.get('WEBHOOK_WORKER_CONCURRENCY', { infer: true });
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

    // `drain()` empties the Redis list, so it must only run on the first
    // attempt — a BullMQ retry re-entering process() would otherwise find an
    // already-drained (empty) list and complete as a silent no-op, losing
    // the message that failed to forward. The drained items are persisted
    // onto the job so retries reuse them instead of draining again.
    let items: DebouncedMessage[];
    if (job.attemptsMade === 0) {
      items = await this.debouncer.drain(debounceKey, contactId);
      if (items.length > 0) {
        await job.updateData({ ...job.data, drainedItems: items });
      }
    } else {
      items = job.data.drainedItems ?? [];
    }
    const drainedCount = items.length;
    if (items.length === 0) {
      // Could happen if a more recent flush job already drained the list.
      this.logger.debug({ jobId: job.id, debounceKey, contactId }, 'Flush ran with empty list');
      return { ok: true, drained: 0 };
    }

    // Video gate: GHL can't tell us an attachment is a video (audio and video
    // both arrive as a `.mp4` URL), so we probe the CDN's Content-Type on
    // every attachment in the batch. Filtering runs per item, not per batch:
    //   - an item whose ONLY attachment(s) are confirmed video is dropped
    //     entirely (text included) — a plain video message carries an empty
    //     body, and a video sent with a text caption is treated the same way.
    //   - an item that also carries a non-video attachment (e.g. a video sent
    //     alongside an image) keeps the item — only the video URL is
    //     stripped — since there's other real content to forward.
    // Runs before the group/contact fetches so a video-only conversation
    // costs nothing downstream. Only pays the HEAD when attachments exist.
    const allAttachments = items.flatMap((i) => i.attachments ?? []);
    if (allAttachments.length > 0 && this.config.get('DROP_INBOUND_VIDEO', { infer: true })) {
      const { videoUrls } = await this.classifier.partitionVideos(allAttachments, String(job.id));
      if (videoUrls.length > 0) {
        const videoUrlSet = new Set(videoUrls);
        const survivingItems: typeof items = [];
        let droppedItems = 0;
        for (const item of items) {
          const itemAttachments = item.attachments ?? [];
          const nonVideoAttachments = itemAttachments.filter((url) => !videoUrlSet.has(url));
          if (nonVideoAttachments.length === itemAttachments.length) {
            survivingItems.push(item); // No video on this item — unaffected.
          } else if (nonVideoAttachments.length > 0) {
            survivingItems.push({ ...item, attachments: nonVideoAttachments });
          } else {
            droppedItems++; // Item's only attachment(s) were video — drop it entirely.
          }
        }

        this.logger.log(
          { jobId: job.id, contactId, droppedItems, survivingItems: survivingItems.length },
          'Dropped video-only item(s) from inbound flush',
        );

        if (survivingItems.length === 0) {
          this.logger.log(
            { jobId: job.id, contactId, drained: drainedCount },
            'Inbound flush dropped — every item was video-only',
          );
          return {
            ok: true,
            drained: drainedCount,
            totalMs: Date.now() - started,
            skipped: 'video',
          };
        }
        items = survivingItems;
      }
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

    // Availability gate: if the group defines an `ai_schedule` and the current
    // time falls outside its active window, do not invoke the AI. This covers
    // BOTH sources — inbound replies and workflow-sourced flushes (insistence
    // follow-ups): if the AI may not reply to a contact right now, it must not
    // nudge them either. Absent/null schedule => 24/7 (no change).
    if (!isAiAvailable(group.aiSchedule, new Date())) {
      this.logger.log(
        {
          jobId: job.id,
          locationId,
          contactId,
          source,
          timezone: group.aiSchedule?.timezone,
        },
        'AI gate stopped flow — outside ai_schedule window',
      );
      return {
        ok: true,
        drained: drainedCount,
        totalMs: Date.now() - started,
        skipped: 'ai_off_hours',
      };
    }

    // The contact is fetched up-front: inbound agent resolution can be
    // overridden by a per-contact custom field, and the AI gate + custom_fields
    // enrichment below need it regardless.
    const contact = await this.contactClient.get({
      jobId: String(job.id),
      contactId,
      apiKey: group.apiKey,
    });

    // Hard stop: a contact tagged with "desactivar ia" opts out of the AI
    // entirely. Skip everything downstream (agent resolution, AI gate, forward)
    // and drop the drained messages. Tags are already normalized (lowercased +
    // trimmed) by the contact client; `?? []` tolerates a partial contact.
    if ((contact.tags ?? []).includes(AI_DISABLE_TAG)) {
      this.logger.log(
        { jobId: job.id, contactId, locationId, tag: AI_DISABLE_TAG, drained: drainedCount },
        'Flow skipped — contact has "desactivar ia" tag',
      );
      return {
        ok: true,
        drained: drainedCount,
        totalMs: Date.now() - started,
        skipped: 'ai_disabled_tag',
      };
    }

    // Inbound flushes resolve agentId with this precedence:
    //   contact.<AGENT_FIELD_KEY> (e.g. contact.aiagent) when set
    //     -> channel_agents.<channel>
    //     -> default_agent
    //     -> skip (no agent to forward to).
    // The per-contact override lets a single contact pin a specific agent even
    // when the location has no default configured.
    let agentId: string;
    if (source === 'inbound') {
      const contactAgent = await this.resolveContactAgent(
        contact,
        locationId,
        group.apiKey,
        String(job.id),
      );
      const channelAgent = resolveAgentForChannel(group.channelAgents, replyChannel);
      const resolved = contactAgent ?? channelAgent ?? group.defaultAgent;
      if (!resolved) {
        this.logger.log(
          { jobId: job.id, locationId, contactId, replyChannel },
          'Inbound flush skipped — no contact agent, channel_agent or default_agent configured',
        );
        return {
          ok: true,
          drained: drainedCount,
          totalMs: Date.now() - started,
          skipped: 'no_default_agent',
        };
      }
      if (contactAgent) {
        this.logger.log(
          { jobId: job.id, locationId, contactId, agentId: contactAgent },
          'Inbound agent_id overridden by contact custom field',
        );
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
        drained: drainedCount,
        replyChannel,
      },
      'Flushing debounced messages',
    );

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
          drained: drainedCount,
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

    // Resolve the contact's assigned GHL user (agent) into { id, name, email }
    // for the chat API. Best-effort: if the lookup fails we forward without
    // `assigned_user` rather than fail the job.
    let assignedUser: AssignedUser | undefined;
    if (contact.assignedTo) {
      try {
        assignedUser = await this.contactClient.getUser({
          jobId: String(job.id),
          userId: contact.assignedTo,
          apiKey: group.apiKey,
        });
      } catch (err) {
        this.logger.warn(
          { jobId: job.id, contactId, userId: contact.assignedTo, err: (err as Error).message },
          'Assigned user resolution failed — forwarding without assigned_user',
        );
      }
    }

    // Forward the contact's tags to the chat API, excluding the AI-control tag
    // (a contact carrying `desactivar ia` never reaches here — the hard-stop
    // above returns early — so the filter is defensive). Omitted when empty.
    const tags = (contact.tags ?? []).filter((t) => t !== AI_DISABLE_TAG);

    const chat = await this.forwarder.forward({
      jobId: String(job.id),
      agentId,
      contactId,
      locationId,
      apiKey: group.apiKey,
      body: concatenated,
      channel: replyChannel,
      contactName: contact.firstName,
      contactEmail: contact.email,
      contactPhone: contact.phone,
      tags: tags.length > 0 ? tags : undefined,
      customFields,
      assignedUser,
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
      drained: drainedCount,
      chatStatus: 200,
      ghlStatus: lastStatus,
      totalMs: Date.now() - started,
    };
  }

  /**
   * Resolves the inbound agent override from the contact's custom field whose
   * `fieldKey` is `AGENT_FIELD_KEY` (default `contact.aiagent`). Returns its
   * value (the agent id) when set, else `undefined`. Best-effort: the
   * field-definition lookup is wrapped so a failure falls back to the
   * channel/default agent rather than failing the job. The definitions are
   * cached per location, so this shares the fetch with the custom_fields
   * enrichment below.
   */
  private async resolveContactAgent(
    contact: GetContactResult,
    locationId: string,
    apiKey: string,
    jobId: string,
  ): Promise<string | undefined> {
    if (contact.customFields.length === 0) return undefined;
    const fieldKey = this.config.get('AGENT_FIELD_KEY', { infer: true });
    try {
      const defs = await this.contactClient.listFieldDefs({ jobId, locationId, apiKey });
      return resolveFieldValueByKey(contact.customFields, defs.keyToId, fieldKey);
    } catch (err) {
      this.logger.warn(
        { jobId, locationId, err: (err as Error).message },
        'Contact agent override resolution failed — falling back to channel/default agent',
      );
      return undefined;
    }
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
