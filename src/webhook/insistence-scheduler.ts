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

/**
 * Fire-and-forget follow-up scheduler. After the chat reply is delivered we
 * map `general_settings.insistences` (already fetched by `GroupFetcher`)
 * into total-minute offsets and POST them to `JOBS_URL/insistence`.
 *
 * Every failure is logged and swallowed — the BullMQ job must never fail
 * because of insistence scheduling, since the chat reply has already been
 * delivered to the user.
 */
@Injectable()
export class InsistenceScheduler {
  private readonly logger = new Logger(InsistenceScheduler.name);
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
