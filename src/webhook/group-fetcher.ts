import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { AppEnv } from '../config/env.validation';

export interface InsistenceEntry {
  hours?: number;
  minutes?: number;
}

export interface AiFieldRef {
  id: string;
  key: string;
}

export interface NonBlockingUser {
  id: string;
  name: string;
}

export interface GroupSettings {
  apiKey: string;
  insistences?: InsistenceEntry[];
  aiFieldId?: AiFieldRef;
  defaultAgent?: string;
  nonBlockingUsers?: NonBlockingUser[];
}

interface GroupResponse {
  api_key?: string;
  general_settings?: {
    insistences?: InsistenceEntry[];
    ai_field_id?: { id?: unknown; key?: unknown };
    default_agent?: unknown;
    non_blocking_users?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Fetches the per-location group settings from `CHAT_API_URL/groups/by-location/{id}`.
 *
 * The returned `apiKey` is load-bearing: it authenticates the GHL reply
 * to the contact and the follow-up POST to `JOBS_URL/insistence`. So this
 * call uses the same retry contract as the other downstream services:
 *  - 2xx with `api_key` → success.
 *  - 2xx without `api_key` → `UnrecoverableError` (group misconfigured).
 *  - 4xx → `UnrecoverableError` (no retry — location not found / bad path).
 *  - 5xx / network / timeout → regular `Error` (BullMQ retries).
 */
@Injectable()
export class GroupFetcher {
  private readonly logger = new Logger(GroupFetcher.name);
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

  async fetch(locationId: string, jobId: string): Promise<GroupSettings> {
    const path = `/groups/by-location/${encodeURIComponent(locationId)}`;
    let response;
    try {
      response = await this.client.get(path);
    } catch (err) {
      const axiosErr = err as AxiosError;
      const code = axiosErr.code ?? 'UNKNOWN';
      this.logger.warn(
        { jobId, locationId, code, msg: axiosErr.message },
        'Group fetch transport error',
      );
      throw new Error(`Group fetch transport error (${code}): ${axiosErr.message}`);
    }

    const { status } = response;

    if (status >= 200 && status < 300) {
      if (!response.data || typeof response.data !== 'object') {
        this.logger.warn(
          { jobId, locationId, status },
          'Group fetch returned 2xx with non-object body — non-retryable',
        );
        throw new UnrecoverableError(
          `Group fetch returned ${status} with non-object body`,
        );
      }
      const body = response.data as GroupResponse;
      const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
      if (!apiKey) {
        this.logger.warn(
          { jobId, locationId, status },
          'Group fetch returned 2xx without api_key — non-retryable',
        );
        throw new UnrecoverableError(
          `Group for location ${locationId} has no api_key`,
        );
      }
      return {
        apiKey,
        insistences: body.general_settings?.insistences,
        aiFieldId: parseAiFieldId(body.general_settings?.ai_field_id),
        defaultAgent: parseDefaultAgent(body.general_settings?.default_agent),
        nonBlockingUsers: parseNonBlockingUsers(body.general_settings?.non_blocking_users),
      };
    }

    const summary = summarizeBody(response.data);

    if (status >= 400 && status < 500) {
      this.logger.warn(
        { jobId, locationId, status, body: summary },
        'Group fetch rejected — non-retryable',
      );
      throw new UnrecoverableError(`Group fetch rejected with ${status}: ${summary}`);
    }

    this.logger.warn(
      { jobId, locationId, status, body: summary },
      'Group fetch errored — retryable',
    );
    throw new Error(`Group fetch returned ${status}: ${summary}`);
  }
}

function parseDefaultAgent(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseNonBlockingUsers(raw: unknown): NonBlockingUser[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const users: NonBlockingUser[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as { id?: unknown; name?: unknown };
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) continue;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    users.push({ id, name });
  }
  return users.length > 0 ? users : undefined;
}

function parseAiFieldId(raw: unknown): AiFieldRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { id?: unknown; key?: unknown };
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const key = typeof r.key === 'string' ? r.key.trim() : '';
  if (!id || !key) return undefined;
  return { id, key };
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
