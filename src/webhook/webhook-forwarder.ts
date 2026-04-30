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
  body: string;
  contactName?: string;
  receivedAt: string;
  requestId: string | undefined;
}

export interface ChatResponse {
  message: string;
  durationMs: number;
}

/**
 * POSTs the coalesced inbound message to the configured AI service at
 * `${CHAT_API_URL}/chat` and returns its `message` field.
 *
 * Failure handling matches BullMQ's retry contract:
 *  - 2xx with a non-empty `message` → success.
 *  - 2xx with a missing/empty `message` → `UnrecoverableError` (contract
 *    violation — retrying won't help).
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

    const body = {
      agent_id: req.agentId,
      contact_id: req.contactId,
      contact_data: req.contactName ? { name: req.contactName } : {},
      message: { body: req.body },
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
      const reply = extractMessage(response.data);
      if (!reply) {
        this.logger.warn(
          { jobId: req.jobId, status, durationMs, body: summarizeBody(response.data) },
          'Chat API responded 2xx without a message — non-retryable',
        );
        throw new UnrecoverableError(
          `Chat API responded ${status} without a non-empty "message" field`,
        );
      }
      this.logger.log({ jobId: req.jobId, status, durationMs }, 'Chat API replied');
      return { message: reply, durationMs };
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

function extractMessage(data: unknown): string {
  if (data && typeof data === 'object' && 'message' in data) {
    const m = (data as { message: unknown }).message;
    if (typeof m === 'string' && m.trim().length > 0) {
      return m;
    }
  }
  return '';
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
