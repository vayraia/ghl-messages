import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { ReplyChannel } from './channel-resolver';

export interface GhlReplyInput {
  jobId: string;
  contactId: string;
  message: string;
  type: ReplyChannel;
}

export interface GhlReplyResult {
  status: number;
  durationMs: number;
}

/**
 * Sends the AI's reply to the contact via GHL's
 * `POST /conversations/messages` endpoint, using the same retry-split
 * convention as the chat forwarder so BullMQ owns the retry policy.
 */
@Injectable()
export class GhlReply {
  private readonly logger = new Logger(GhlReply.name);
  private readonly client: AxiosInstance;

  constructor(config: ConfigService<AppEnv, true>) {
    const baseURL: string = config.get('GHL_API_BASE_URL', { infer: true });
    const apiKey: string = config.get('GHL_API_KEY', { infer: true });
    const version: string = config.get('GHL_API_VERSION', { infer: true });
    const timeout: number = config.get('GHL_API_TIMEOUT_MS', { infer: true });

    this.client = axios.create({
      baseURL,
      timeout,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Version: version,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
      maxRedirects: 0,
    });
  }

  async send(input: GhlReplyInput): Promise<GhlReplyResult> {
    const body = {
      contactId: input.contactId,
      message: input.message,
      type: input.type,
    };

    const started = Date.now();
    let response;
    try {
      response = await this.client.post('/conversations/messages', body);
    } catch (err) {
      const axiosErr = err as AxiosError;
      const code = axiosErr.code ?? 'UNKNOWN';
      this.logger.warn({ jobId: input.jobId, code, msg: axiosErr.message }, 'GHL transport error');
      throw new Error(`GHL transport error (${code}): ${axiosErr.message}`);
    }

    const durationMs = Date.now() - started;
    const { status } = response;

    if (status >= 200 && status < 300) {
      this.logger.log(
        { jobId: input.jobId, status, durationMs, type: input.type },
        'GHL accepted reply',
      );
      return { status, durationMs };
    }

    const summary = summarizeBody(response.data);

    if (status >= 400 && status < 500) {
      this.logger.warn(
        { jobId: input.jobId, status, durationMs, body: summary },
        'GHL rejected — non-retryable',
      );
      throw new UnrecoverableError(`GHL rejected with ${status}: ${summary}`);
    }

    this.logger.warn(
      { jobId: input.jobId, status, durationMs, body: summary },
      'GHL errored — retryable',
    );
    throw new Error(`GHL returned ${status}: ${summary}`);
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
