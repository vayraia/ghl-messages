import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { REQUEST_ID_HEADER } from '../common/middleware/request-id.middleware';

export interface ChatRequest {
  jobId: string;
  agentId: string;
  contactId: string;
  locationId: string;
  apiKey: string;
  body: string;
  contactName?: string;
  customFields?: Record<string, string>;
  attachments?: string[];
  receivedAt: string;
  requestId: string | undefined;
}

export type ChatMessage =
  | { type: 'text'; content: string }
  | { type: 'image'; url: string; caption?: string }
  | { type: 'file'; url: string; filename?: string };

export interface ChatResponse {
  messages: ChatMessage[];
  durationMs: number;
}

/**
 * POSTs the coalesced inbound message to the configured AI service at
 * `${CHAT_API_URL}/chat` and returns its `messages` array.
 *
 * Failure handling matches BullMQ's retry contract:
 *  - 2xx with a non-empty `messages` array of valid entries → success.
 *  - 2xx with a missing/empty/invalid `messages` field → `UnrecoverableError`
 *    (contract violation — retrying won't help).
 *  - 4xx → `UnrecoverableError` (no retry).
 *  - 5xx / network / timeout → regular `Error` (BullMQ retries).
 */
@Injectable()
export class WebhookForwarder {
  private readonly logger = new Logger(WebhookForwarder.name);
  private readonly client: AxiosInstance;

  constructor(config: ConfigService<AppEnv, true>) {
    const baseURL: string = config.get('CHAT_API_URL', { infer: true });
    const timeout: number = config.get('CHAT_API_TIMEOUT_MS', { infer: true });

    this.client = axios.create({
      baseURL,
      timeout,
      headers: { 'content-type': 'application/json' },
      validateStatus: () => true,
      maxRedirects: 0,
    });
  }

  async forward(req: ChatRequest): Promise<ChatResponse> {
    const headers: Record<string, string> = {
      'x-webhook-job-id': req.jobId,
      'x-webhook-received-at': req.receivedAt,
    };
    if (req.requestId) {
      headers[REQUEST_ID_HEADER] = req.requestId;
    }

    const message: { body: string; attachments?: string[] } = { body: req.body };
    if (req.attachments && req.attachments.length > 0) {
      message.attachments = req.attachments;
    }

    // Custom fields are spread directly into contact_data (by their GHL name,
    // e.g. "Reprogramar Cita"). The reserved keys (ghl_token, location_id,
    // name) are assigned AFTER the spread so a custom field can never shadow
    // them.
    const contact_data: Record<string, string> = {};
    if (req.customFields) {
      Object.assign(contact_data, req.customFields);
    }
    contact_data.ghl_token = req.apiKey;
    contact_data.location_id = req.locationId;
    if (req.contactName) {
      contact_data.name = req.contactName;
    }

    const body = {
      agent_id: req.agentId,
      contact_id: req.contactId,
      contact_data,
      message,
    };

    const started = Date.now();
    let response;
    try {
      response = await this.client.post('/chat', body, { headers });
    } catch (err) {
      const axiosErr = err as AxiosError;
      const code = axiosErr.code ?? 'UNKNOWN';
      this.logger.warn(
        { jobId: req.jobId, code, msg: axiosErr.message },
        'Chat API transport error',
      );
      throw new Error(`Chat API transport error (${code}): ${axiosErr.message}`);
    }

    const durationMs = Date.now() - started;
    const { status } = response;

    if (status >= 200 && status < 300) {
      const messages = extractMessages(response.data);
      if (!messages) {
        this.logger.warn(
          { jobId: req.jobId, status, durationMs, body: summarizeBody(response.data) },
          'Chat API responded 2xx with invalid messages — non-retryable',
        );
        throw new UnrecoverableError(
          `Chat API responded ${status} without a valid non-empty "messages" array`,
        );
      }
      this.logger.log(
        {
          jobId: req.jobId,
          status,
          durationMs,
          count: messages.length,
          messages: summarizeBody(messages),
        },
        'Chat API replied',
      );
      return { messages, durationMs };
    }

    const summary = summarizeBody(response.data);

    if (status >= 400 && status < 500) {
      this.logger.warn(
        { jobId: req.jobId, status, durationMs, body: summary },
        'Chat API rejected — non-retryable',
      );
      throw new UnrecoverableError(`Chat API rejected with ${status}: ${summary}`);
    }

    this.logger.warn(
      { jobId: req.jobId, status, durationMs, body: summary },
      'Chat API errored — retryable',
    );
    throw new Error(`Chat API returned ${status}: ${summary}`);
  }
}

/**
 * Validates the `/chat` response shape. Returns the typed `messages` array on
 * success or `undefined` if the payload is missing it, has the wrong shape,
 * or contains any element that fails per-type validation.
 */
function extractMessages(data: unknown): ChatMessage[] | undefined {
  if (!data || typeof data !== 'object' || !('messages' in data)) return undefined;
  const raw = (data as { messages: unknown }).messages;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const out: ChatMessage[] = [];
  for (const entry of raw) {
    const parsed = parseChatMessage(entry);
    if (!parsed) return undefined;
    out.push(parsed);
  }
  return out;
}

function parseChatMessage(entry: unknown): ChatMessage | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const e = entry as Record<string, unknown>;
  switch (e.type) {
    case 'text': {
      const content = e.content;
      if (typeof content !== 'string' || content.trim().length === 0) return undefined;
      return { type: 'text', content };
    }
    case 'image': {
      const url = e.url;
      if (typeof url !== 'string' || url.length === 0) return undefined;
      const caption = typeof e.caption === 'string' ? e.caption : undefined;
      return { type: 'image', url, ...(caption !== undefined ? { caption } : {}) };
    }
    case 'file': {
      const url = e.url;
      if (typeof url !== 'string' || url.length === 0) return undefined;
      const filename = typeof e.filename === 'string' ? e.filename : undefined;
      return { type: 'file', url, ...(filename !== undefined ? { filename } : {}) };
    }
    default:
      return undefined;
  }
}

function summarizeBody(body: unknown): string {
  const s = typeof body === 'string' ? body : safeStringify(body);
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '[unserializable]';
  }
}
