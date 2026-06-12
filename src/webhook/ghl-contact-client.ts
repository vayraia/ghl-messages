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
  email?: string;
  phone?: string;
  assignedTo?: string;
  durationMs: number;
}

export interface GetUserInput {
  jobId: string;
  userId: string;
  apiKey: string;
}

/**
 * The assigned GHL user (agent) resolved from the contact's `assignedTo`,
 * carrying its `id` plus best-effort `name`/`email`/`phone`. This is the shape
 * of `contact_data.assigned_user`.
 */
export interface AssignedUser {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
}

export interface ListCustomFieldsInput {
  jobId: string;
  locationId: string;
  apiKey: string;
}

/**
 * Custom-field definitions change rarely, so we cache the `id → name` map per
 * location to keep them out of the per-message hot path. Five minutes is short
 * enough that a freshly-added field shows up quickly, long enough to spare GHL
 * a GET on every inbound message.
 */
const CUSTOM_FIELDS_CACHE_TTL_MS = 5 * 60_000;

/**
 * Users (the human agents a contact is assigned to) change rarely, so we cache
 * the resolved `{ id, name, email }` per user id to keep the lookup out of the
 * per-message hot path. Same five-minute window as the custom-field defs.
 */
const USER_CACHE_TTL_MS = 5 * 60_000;

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
  private readonly fieldDefCache = new Map<
    string,
    { expiresAt: number; defs: Map<string, string> }
  >();
  private readonly userCache = new Map<string, { expiresAt: number; user: AssignedUser }>();

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
      const email = extractContactString(response.data, 'email');
      const phone = extractContactString(response.data, 'phone');
      const assignedTo = extractAssignedTo(response.data);
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
      return { status, customFields, firstName, email, phone, assignedTo, durationMs };
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

  /**
   * Reads the location's custom-field definitions and returns an `id → name`
   * map (cached per location for `CUSTOM_FIELDS_CACHE_TTL_MS`). Used to resolve
   * the contact's `customFields` (which carry only `id`/`value`) into the
   * human-readable names the chat API expects in `contact_data.custom_fields`.
   *
   * Same retry-split as `get`: 4xx → `UnrecoverableError`, 5xx/network →
   * `Error`. Callers should treat enrichment as best-effort and not fail the
   * job on a throw — field names are not load-bearing like the AI gate.
   */
  async listCustomFields(input: ListCustomFieldsInput): Promise<Map<string, string>> {
    const now = Date.now();
    const cached = this.fieldDefCache.get(input.locationId);
    if (cached && cached.expiresAt > now) {
      return cached.defs;
    }

    const path = `/locations/${encodeURIComponent(input.locationId)}/customFields`;
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
        { jobId: input.jobId, locationId: input.locationId, code, msg: axiosErr.message },
        'Custom fields read transport error',
      );
      throw new Error(`Custom fields read transport error (${code}): ${axiosErr.message}`);
    }

    const durationMs = Date.now() - started;
    const { status } = response;

    if (status >= 200 && status < 300) {
      const defs = extractCustomFieldDefs(response.data);
      this.fieldDefCache.set(input.locationId, {
        expiresAt: now + CUSTOM_FIELDS_CACHE_TTL_MS,
        defs,
      });
      this.logger.debug(
        {
          jobId: input.jobId,
          locationId: input.locationId,
          status,
          durationMs,
          fieldCount: defs.size,
        },
        'GHL custom fields read',
      );
      return defs;
    }

    const summary = summarizeBody(response.data);

    if (status >= 400 && status < 500) {
      this.logger.warn(
        { jobId: input.jobId, locationId: input.locationId, status, durationMs, body: summary },
        'GHL custom fields read rejected — non-retryable',
      );
      throw new UnrecoverableError(`GHL custom fields read rejected with ${status}: ${summary}`);
    }

    this.logger.warn(
      { jobId: input.jobId, locationId: input.locationId, status, durationMs, body: summary },
      'GHL custom fields read errored — retryable',
    );
    throw new Error(`GHL custom fields read returned ${status}: ${summary}`);
  }

  /**
   * Resolves the contact's assigned GHL user (agent) by id via `GET /users/:id`
   * and returns `{ id, name, email }` (cached per user id for
   * `USER_CACHE_TTL_MS`). Used to populate `contact_data.assigned_user` so the
   * chat API knows which human agent owns the contact.
   *
   * Same retry-split as `get`: 4xx → `UnrecoverableError`, 5xx/network →
   * `Error`. Callers should treat this as best-effort and forward without
   * `assigned_user` rather than fail the job on a throw.
   */
  async getUser(input: GetUserInput): Promise<AssignedUser> {
    const now = Date.now();
    const cached = this.userCache.get(input.userId);
    if (cached && cached.expiresAt > now) {
      return cached.user;
    }

    const path = `/users/${encodeURIComponent(input.userId)}`;
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
        { jobId: input.jobId, userId: input.userId, code, msg: axiosErr.message },
        'User read transport error',
      );
      throw new Error(`User read transport error (${code}): ${axiosErr.message}`);
    }

    const durationMs = Date.now() - started;
    const { status } = response;

    if (status >= 200 && status < 300) {
      const user = extractUser(response.data, input.userId);
      this.userCache.set(input.userId, {
        expiresAt: now + USER_CACHE_TTL_MS,
        user,
      });
      this.logger.debug(
        { jobId: input.jobId, userId: input.userId, status, durationMs },
        'GHL user read',
      );
      return user;
    }

    const summary = summarizeBody(response.data);

    if (status >= 400 && status < 500) {
      this.logger.warn(
        { jobId: input.jobId, userId: input.userId, status, durationMs, body: summary },
        'GHL user read rejected — non-retryable',
      );
      throw new UnrecoverableError(`GHL user read rejected with ${status}: ${summary}`);
    }

    this.logger.warn(
      { jobId: input.jobId, userId: input.userId, status, durationMs, body: summary },
      'GHL user read errored — retryable',
    );
    throw new Error(`GHL user read returned ${status}: ${summary}`);
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
  const raw =
    typeof root.firstName === 'string'
      ? root.firstName
      : typeof root.contact?.firstName === 'string'
        ? root.contact.firstName
        : undefined;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Extracts a top-level string field (e.g. `email`, `phone`) from a GHL contact
 * GET response. Tolerates both the top-level and nested `contact.<key>` shapes,
 * and returns `undefined` on any missing or blank value.
 */
function extractContactString(
  data: unknown,
  key: 'email' | 'phone',
): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const root = data as Record<string, unknown> & { contact?: Record<string, unknown> };
  const raw =
    typeof root[key] === 'string'
      ? (root[key] as string)
      : typeof root.contact?.[key] === 'string'
        ? (root.contact[key] as string)
        : undefined;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Extracts the `assignedTo` user id from a GHL contact GET response. Tolerates
 * both top-level `assignedTo` and nested `contact.assignedTo`, and returns
 * `undefined` on any missing or blank value.
 */
function extractAssignedTo(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const root = data as { assignedTo?: unknown; contact?: { assignedTo?: unknown } };
  const raw =
    typeof root.assignedTo === 'string'
      ? root.assignedTo
      : typeof root.contact?.assignedTo === 'string'
        ? root.contact.assignedTo
        : undefined;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Extracts an `AssignedUser` from a GHL `GET /users/:id` response. Tolerates a
 * top-level user object or a nested `user` wrapper. Builds `name` from an
 * explicit `name`, falling back to `firstName`/`lastName`; `email` is included
 * only when it is a non-blank string. `id` falls back to the requested userId
 * when the response omits it.
 */
function extractUser(data: unknown, fallbackId: string): AssignedUser {
  const root = (
    data && typeof data === 'object'
      ? (data as { user?: unknown }).user && typeof (data as { user?: unknown }).user === 'object'
        ? (data as { user: Record<string, unknown> }).user
        : (data as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>;

  const id = typeof root.id === 'string' && root.id.trim().length > 0 ? root.id.trim() : fallbackId;
  const name = pickUserName(root);
  const email =
    typeof root.email === 'string' && root.email.trim().length > 0 ? root.email.trim() : undefined;
  const phone =
    typeof root.phone === 'string' && root.phone.trim().length > 0 ? root.phone.trim() : undefined;

  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(phone !== undefined ? { phone } : {}),
  };
}

/**
 * Resolves a user's display name from a GHL user object: prefers an explicit
 * non-blank `name`, otherwise joins `firstName`/`lastName`. Returns `undefined`
 * when nothing usable is present.
 */
function pickUserName(root: Record<string, unknown>): string | undefined {
  if (typeof root.name === 'string') {
    const trimmed = root.name.trim();
    if (trimmed.length > 0) return trimmed;
  }
  const parts: string[] = [];
  if (typeof root.firstName === 'string' && root.firstName.trim().length > 0) {
    parts.push(root.firstName.trim());
  }
  if (typeof root.lastName === 'string' && root.lastName.trim().length > 0) {
    parts.push(root.lastName.trim());
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
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

/**
 * Extracts the `id → name` map from a GHL `GET /locations/:id/customFields`
 * response. Skips entries without a string id or a non-blank name, and returns
 * an empty map on any unexpected structure.
 */
function extractCustomFieldDefs(data: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!data || typeof data !== 'object') return out;
  const root = data as { customFields?: unknown };
  const raw = Array.isArray(root.customFields) ? root.customFields : null;
  if (!raw) return out;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { id?: unknown; name?: unknown };
    if (typeof e.id !== 'string' || e.id.length === 0) continue;
    if (typeof e.name !== 'string') continue;
    const name = e.name.trim();
    if (name.length === 0) continue;
    out.set(e.id, name);
  }
  return out;
}

/**
 * A contact custom field resolved against the location's definitions, carrying
 * its `id`, human-readable `name` and normalized string `value`. This is the
 * element shape of `contact_data.custom_fields`.
 */
export interface NamedCustomField {
  id: string;
  name: string;
  value: string;
}

/**
 * Joins the contact's `customFields` (id → value) with the location's
 * definitions (id → name) into an array of `{ id, name, value }` suitable for
 * `contact_data.custom_fields`. Fields whose id has no definition, or whose
 * value normalizes to empty, are dropped. Duplicate names are preserved as
 * separate entries (each keeps its own id).
 */
export function buildNamedCustomFields(
  fields: ContactCustomField[],
  defs: Map<string, string>,
): NamedCustomField[] {
  const out: NamedCustomField[] = [];
  for (const f of fields) {
    const name = defs.get(f.id);
    if (!name) continue;
    const value = normalizeFieldValue(f.value);
    if (value === undefined) continue;
    out.push({ id: f.id, name, value });
  }
  return out;
}

/**
 * Coerces a GHL custom-field value (typed `unknown`) to a string for the chat
 * API. Strings are trimmed; numbers/booleans are stringified; arrays (e.g.
 * multi-select) are joined; anything else (objects, null) is dropped.
 */
function normalizeFieldValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const t = value.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .filter((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0);
    return parts.length > 0 ? parts.join(', ') : undefined;
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
