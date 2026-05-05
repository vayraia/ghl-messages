import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { AppEnv } from '../config/env.validation';
import { ReplyChannel } from './channel-resolver';
import { InsistenceEntry } from './group-fetcher';

export interface ScheduleInput {
  jobId: string;
  locationId: string;
  contactId: string;
  agentId: string;
  apiKey: string;
  replyChannel: ReplyChannel;
  insistences?: InsistenceEntry[];
}

export interface CancelInput {
  jobId: string;
  contactId: string;
}

/**
 * HTTP client for the JOBS_URL `/insistence` resource.
 *
 *  - `schedule()` posts follow-up offsets after a chat reply lands.
 *  - `cancel()` deletes pending insistences for a contact when a human
 *    takes over the conversation (outbound webhook flow).
 *
 * Both methods are fire-and-forget: every failure is logged and
 * swallowed so they never bubble up and abort the surrounding flow.
 * The chat reply / human takeover has already happened by the time
 * either runs — failing here must not undo that.
 */
@Injectable()
export class InsistenceClient {
  private readonly logger = new Logger(InsistenceClient.name);
  private readonly client: AxiosInstance;

  constructor(config: ConfigService<AppEnv, true>) {
    const baseURL: string = config.get('JOBS_URL', { infer: true });
    const timeout: number = config.get('JOBS_API_TIMEOUT_MS', { infer: true });

    this.client = axios.create({
      baseURL,
      timeout,
      headers: { 'content-type': 'application/json' },
      validateStatus: () => true,
      maxRedirects: 0,
    });
  }

  async schedule(input: ScheduleInput): Promise<void> {
    const insistences = input.insistences;
    if (!Array.isArray(insistences) || insistences.length === 0) {
      this.logger.debug(
        { jobId: input.jobId, locationId: input.locationId },
        'Insistence skipped — no insistences configured',
      );
      return;
    }

    const times = mapInsistencesToMinutes(insistences);
    if (times.length === 0) {
      this.logger.debug(
        { jobId: input.jobId, locationId: input.locationId, raw: insistences.length },
        'Insistence skipped — all entries mapped to non-positive minutes',
      );
      return;
    }

    const body = {
      times,
      locationId: input.locationId,
      contactId: input.contactId,
      agentId: input.agentId,
      apiKey: input.apiKey,
      replyChannel: input.replyChannel,
    };

    let response;
    try {
      response = await this.client.post('/insistence', body);
    } catch (err) {
      const axiosErr = err as AxiosError;
      this.logger.warn(
        {
          jobId: input.jobId,
          locationId: input.locationId,
          code: axiosErr.code ?? 'UNKNOWN',
          msg: axiosErr.message,
        },
        'Insistence POST transport error',
      );
      return;
    }

    const { status } = response;
    if (status >= 200 && status < 300) {
      this.logger.log(
        {
          jobId: input.jobId,
          locationId: input.locationId,
          status,
          count: times.length,
        },
        'Insistence scheduled',
      );
      return;
    }

    this.logger.warn(
      {
        jobId: input.jobId,
        locationId: input.locationId,
        status,
        body: summarizeBody(response.data),
      },
      'Insistence POST returned non-2xx',
    );
  }

  async cancel(input: CancelInput): Promise<void> {
    const path = `/insistence/${encodeURIComponent(input.contactId)}`;
    let response;
    try {
      response = await this.client.delete(path);
    } catch (err) {
      const axiosErr = err as AxiosError;
      this.logger.warn(
        {
          jobId: input.jobId,
          contactId: input.contactId,
          code: axiosErr.code ?? 'UNKNOWN',
          msg: axiosErr.message,
        },
        'Insistence DELETE transport error (swallowed)',
      );
      return;
    }

    const { status } = response;

    if (status >= 200 && status < 300) {
      this.logger.log(
        { jobId: input.jobId, contactId: input.contactId, status },
        'Insistences cancelled',
      );
      return;
    }

    if (status === 404) {
      this.logger.log(
        { jobId: input.jobId, contactId: input.contactId, status },
        'Insistence DELETE returned 404 — no insistences to cancel (treated as normal)',
      );
      return;
    }

    this.logger.warn(
      {
        jobId: input.jobId,
        contactId: input.contactId,
        status,
        body: summarizeBody(response.data),
      },
      'Insistence DELETE returned non-2xx (swallowed)',
    );
  }
}

function mapInsistencesToMinutes(entries: InsistenceEntry[]): number[] {
  const out: number[] = [];
  for (const entry of entries) {
    const h = Number(entry?.hours ?? 0);
    const m = Number(entry?.minutes ?? 0);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
    const total = h * 60 + m;
    if (total > 0) out.push(total);
  }
  return out;
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
