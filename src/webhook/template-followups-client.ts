import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { AppEnv } from '../config/env.validation';

export interface CancelTemplateFollowupsInput {
  contactId: string;
  locationId: string;
}

/**
 * HTTP client for the JOBS_URL `/template-followups` resource.
 *
 *  - `cancel()` deletes the contact's pending template follow-ups when the
 *    contact replies (inbound webhook flow).
 *
 * Fire-and-forget: every failure is logged and swallowed so it never bubbles
 * up and alters inbound processing. When `JOBS_URL` is unset it does nothing.
 */
@Injectable()
export class TemplateFollowupsClient {
  private readonly logger = new Logger(TemplateFollowupsClient.name);
  private readonly client?: AxiosInstance;

  constructor(config: ConfigService<AppEnv, true>) {
    const baseURL: string | undefined = config.get('JOBS_URL', { infer: true });
    const timeout: number = config.get('JOBS_API_TIMEOUT_MS', { infer: true });

    if (!baseURL) return;

    this.client = axios.create({
      baseURL,
      timeout,
      headers: { 'content-type': 'application/json' },
      validateStatus: () => true,
      maxRedirects: 0,
    });
  }

  async cancel(input: CancelTemplateFollowupsInput): Promise<void> {
    if (!this.client) return;

    const path = `/template-followups/${encodeURIComponent(input.contactId)}`;
    let response;
    try {
      response = await this.client.delete(path, { params: { locationId: input.locationId } });
    } catch (err) {
      const axiosErr = err as AxiosError;
      this.logger.warn(
        {
          contactId: input.contactId,
          locationId: input.locationId,
          code: axiosErr.code ?? 'UNKNOWN',
          msg: axiosErr.message,
        },
        'Template followups DELETE transport error (swallowed)',
      );
      return;
    }

    const { status } = response;

    if (status >= 200 && status < 300) {
      this.logger.log(
        {
          contactId: input.contactId,
          locationId: input.locationId,
          status,
          cancelled: (response.data as { cancelled?: number } | undefined)?.cancelled,
        },
        'Template followups cancelled',
      );
      return;
    }

    if (status === 404) {
      this.logger.log(
        { contactId: input.contactId, locationId: input.locationId, status },
        'Template followups DELETE returned 404 — nothing to cancel (treated as normal)',
      );
      return;
    }

    this.logger.warn(
      {
        contactId: input.contactId,
        locationId: input.locationId,
        status,
        body: summarizeBody(response.data),
      },
      'Template followups DELETE returned non-2xx (swallowed)',
    );
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
