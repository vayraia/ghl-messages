import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { CloudApiSendBody } from './whatsapp-message';

export interface WhatsAppSendInput {
  jobId: string;
  phoneNumberId: string;
  accessToken: string;
  /** Per-tenant Graph API version override; falls back to GRAPH_API_VERSION. */
  version?: string | null;
  body: CloudApiSendBody;
}

export interface WhatsAppSendResult {
  /** WhatsApp message id (wamid...) returned by Meta on success. */
  wamid: string | undefined;
  status: number;
  durationMs: number;
}

/**
 * Meta error codes that are transient even when returned with a 4xx status, so
 * they should be retried rather than treated as permanent failures.
 *  - 130429 / 131056 — messaging / pair rate limits
 *  - 80007            — rate limit issues
 *  - 133016           — temporary account-level throttling
 * https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
const RETRYABLE_META_ERROR_CODES = new Set([130429, 131056, 80007, 133016]);

/**
 * Sends a message via the WhatsApp Cloud API
 * (`POST /{version}/{phone_number_id}/messages`). Mirrors `GhlReply`'s BullMQ
 * retry contract:
 *  - 2xx                        → success (returns the wamid).
 *  - 4xx (auth / validation /   → `UnrecoverableError` (retrying won't help).
 *    24h re-engagement window)
 *  - 429 / 5xx / transient code → regular `Error` (BullMQ retries).
 *  - network / timeout          → regular `Error` (BullMQ retries).
 *
 * The access token is per-tenant and passed per call (never on the shared
 * instance) so it is never logged.
 */
@Injectable()
export class WhatsAppCloudClient {
  private readonly logger = new Logger(WhatsAppCloudClient.name);
  private readonly client: AxiosInstance;
  private readonly defaultVersion: string;

  constructor(config: ConfigService<AppEnv, true>) {
    const baseURL: string = config.get('GRAPH_API_BASE_URL', { infer: true });
    const timeout: number = config.get('GRAPH_API_TIMEOUT_MS', { infer: true });
    this.defaultVersion = config.get('GRAPH_API_VERSION', { infer: true });

    this.client = axios.create({
      baseURL,
      timeout,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
      maxRedirects: 0,
    });
  }

  async send(input: WhatsAppSendInput): Promise<WhatsAppSendResult> {
    const version = input.version && input.version.length > 0 ? input.version : this.defaultVersion;
    const url = `/${version}/${encodeURIComponent(input.phoneNumberId)}/messages`;

    const started = Date.now();
    let response;
    try {
      response = await this.client.post(url, input.body, {
        headers: { Authorization: `Bearer ${input.accessToken}` },
      });
    } catch (err) {
      const axiosErr = err as AxiosError;
      const code = axiosErr.code ?? 'UNKNOWN';
      this.logger.warn(
        { jobId: input.jobId, phoneNumberId: input.phoneNumberId, code, msg: axiosErr.message },
        'WhatsApp Cloud transport error',
      );
      throw new Error(`WhatsApp Cloud transport error (${code}): ${axiosErr.message}`);
    }

    const durationMs = Date.now() - started;
    const { status } = response;

    if (status >= 200 && status < 300) {
      const wamid = extractWamid(response.data);
      this.logger.log(
        { jobId: input.jobId, phoneNumberId: input.phoneNumberId, status, durationMs, wamid },
        'WhatsApp Cloud accepted message',
      );
      return { wamid, status, durationMs };
    }

    const metaCode = extractMetaErrorCode(response.data);
    const summary = summarizeBody(response.data);
    const retryable =
      status === 429 || status >= 500 || RETRYABLE_META_ERROR_CODES.has(metaCode ?? -1);

    if (!retryable && status >= 400 && status < 500) {
      this.logger.warn(
        {
          jobId: input.jobId,
          phoneNumberId: input.phoneNumberId,
          status,
          metaCode,
          durationMs,
          body: summary,
        },
        'WhatsApp Cloud rejected — non-retryable',
      );
      throw new UnrecoverableError(
        `WhatsApp Cloud rejected with ${status} (code ${metaCode}): ${summary}`,
      );
    }

    this.logger.warn(
      {
        jobId: input.jobId,
        phoneNumberId: input.phoneNumberId,
        status,
        metaCode,
        durationMs,
        body: summary,
      },
      'WhatsApp Cloud errored — retryable',
    );
    throw new Error(`WhatsApp Cloud returned ${status} (code ${metaCode}): ${summary}`);
  }
}

function extractWamid(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const messages = (data as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const first = messages[0];
  if (first && typeof first === 'object' && typeof (first as { id?: unknown }).id === 'string') {
    return (first as { id: string }).id;
  }
  return undefined;
}

function extractMetaErrorCode(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const error = (data as { error?: unknown }).error;
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return undefined;
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
