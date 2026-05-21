import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { AppEnv } from '../config/env.validation';

export interface AiFieldRef {
  id: string;
  key: string;
}

export interface DisableAiFieldInput {
  jobId: string;
  contactId: string;
  apiKey: string;
  aiField: AiFieldRef;
}

export interface DisableAiFieldResult {
  status: number;
  durationMs: number;
}

export interface GetContactInput {
  jobId: string;
  contactId: string;
  apiKey: string;
}

export interface ContactCustomField {
  id: string;
  value: unknown;
}

export interface GetContactResult {
  status: number;
  customFields: ContactCustomField[];
  firstName?: string;
  durationMs: number;
}

/**
 * HTTP client for GHL's `/contacts/:id` resource (GET to read custom fields,
 * PUT to update them). Same retry-split convention as `GhlReply`:
 *  - 2xx → success.
 *  - 4xx → `UnrecoverableError` (misconfig — no retry).
 *  - 5xx / network / timeout → regular `Error` (caller decides retry).
 */
@Injectable()
export class GhlContactClient {
  private readonly logger = new Logger(GhlContactClient.name);
  private readonly client: AxiosInstance;

  constructor(config: ConfigService<AppEnv, true>) {
    const baseURL: string = config.get('GHL_API_BASE_URL', { infer: true });
    const version: string = config.get('GHL_API_VERSION', { infer: true });
    const timeout: number = config.get('GHL_API_TIMEOUT_MS', { infer: true });

    this.client = axios.create({
      baseURL,
      timeout,
      headers: {
        Version: version,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
      maxRedirects: 0,
    });
  }

  async get(input: GetContactInput): Promise<GetContactResult> {
    const path = `/contacts/${encodeURIComponent(input.contactId)}`;
    const started = Date.now();
    let response;
    try {
      response = await this.client.get(path, {
        headers: { Authorization: `Bearer ${input.apiKey}` },
      });
    } catch (err) {
      const axiosErr = err as AxiosError;
      const code = axiosErr.code ?? 'UNKNOWN';
      this.logger.warn(
        { jobId: input.jobId, contactId: input.contactId, code, msg: axiosErr.message },
        'Contact read transport error',
      );
      throw new Error(`Contact read transport error (${code}): ${axiosErr.message}`);
    }

    const durationMs = Date.now() - started;
    const { status } = response;

    if (status >= 200 && status < 300) {
      const customFields = extractCustomFields(response.data);
      const firstName = extractFirstName(response.data);
      this.logger.debug(
        {
          jobId: input.jobId,
          contactId: input.contactId,
          status,
          durationMs,
          fieldCount: customFields.length,
        },
        'GHL contact read',
      );
      return { status, customFields, firstName, durationMs };
    }

    const summary = summarizeBody(response.data);

    if (status >= 400 && status < 500) {
      this.logger.warn(
        { jobId: input.jobId, contactId: input.contactId, status, durationMs, body: summary },
        'GHL contact read rejected — non-retryable',
      );
      throw new UnrecoverableError(`GHL contact read rejected with ${status}: ${summary}`);
    }

    this.logger.warn(
      { jobId: input.jobId, contactId: input.contactId, status, durationMs, body: summary },
      'GHL contact read errored — retryable',
    );
    throw new Error(`GHL contact read returned ${status}: ${summary}`);
  }

  async disableAiField(input: DisableAiFieldInput): Promise<DisableAiFieldResult> {
    const body = {
      customFields: [
        {
          id: input.aiField.id,
          key: input.aiField.key,
          field_value: 'Disabled',
        },
      ],
    };

    const path = `/contacts/${encodeURIComponent(input.contactId)}`;
    const started = Date.now();
    let response;
    try {
      response = await this.client.put(path, body, {
        headers: { Authorization: `Bearer ${input.apiKey}` },
      });
    } catch (err) {
      const axiosErr = err as AxiosError;
      const code = axiosErr.code ?? 'UNKNOWN';
      this.logger.warn(
        { jobId: input.jobId, contactId: input.contactId, code, msg: axiosErr.message },
        'Contact update transport error',
      );
      throw new Error(`Contact update transport error (${code}): ${axiosErr.message}`);
    }

    const durationMs = Date.now() - started;
    const { status } = response;

    if (status >= 200 && status < 300) {
      this.logger.log(
        { jobId: input.jobId, contactId: input.contactId, status, durationMs },
        'GHL contact update accepted',
      );
      return { status, durationMs };
    }

    const summary = summarizeBody(response.data);

    if (status >= 400 && status < 500) {
      this.logger.warn(
        { jobId: input.jobId, contactId: input.contactId, status, durationMs, body: summary },
        'GHL contact update rejected — non-retryable',
      );
      throw new UnrecoverableError(`GHL contact update rejected with ${status}: ${summary}`);
    }

    this.logger.warn(
      { jobId: input.jobId, contactId: input.contactId, status, durationMs, body: summary },
      'GHL contact update errored — retryable',
    );
    throw new Error(`GHL contact update returned ${status}: ${summary}`);
  }
}

/**
 * Extracts the customFields array from a GHL contact GET response.
 * Tolerates both top-level `customFields` and nested `contact.customFields`
 * shapes, and returns an empty array on any unexpected structure.
 */
function extractFirstName(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const root = data as { firstName?: unknown; contact?: { firstName?: unknown } };
  const raw = typeof root.firstName === 'string'
    ? root.firstName
    : typeof root.contact?.firstName === 'string'
      ? root.contact.firstName
      : undefined;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractCustomFields(data: unknown): ContactCustomField[] {
  if (!data || typeof data !== 'object') return [];
  const root = data as { customFields?: unknown; contact?: { customFields?: unknown } };
  const raw = Array.isArray(root.customFields)
    ? root.customFields
    : Array.isArray(root.contact?.customFields)
      ? root.contact!.customFields
      : null;
  if (!raw) return [];
  const out: ContactCustomField[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { id?: unknown; value?: unknown };
    if (typeof e.id !== 'string' || e.id.length === 0) continue;
    out.push({ id: e.id, value: e.value });
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
