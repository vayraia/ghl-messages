import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { ReplyChannel } from './channel-resolver';

/**
 * Structured WhatsApp media send. When present (only for `type: 'WhatsApp'`
 * image/file replies), GHL receives the nested `whatsapp.media` body instead of
 * the flat `attachments` array. `name` carries the document filename (documents
 * only). `fromNumberId` is optional: when the group has no `whatsapp_number_id`
 * configured the block is sent without it.
 */
export interface WhatsappMedia {
  type: 'image' | 'document';
  url: string;
  caption: string;
  mimeType: string;
  name?: string;
  fromNumberId?: string;
}

export interface GhlReplyInput {
  jobId: string;
  contactId: string;
  message: string;
  type: ReplyChannel;
  apiKey: string;
  attachments?: string[];
  locationId?: string;
  whatsappMedia?: WhatsappMedia;
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

  async send(input: GhlReplyInput): Promise<GhlReplyResult> {
    const body = buildSendBody(input);

    const started = Date.now();
    let response;
    try {
      response = await this.client.post('/conversations/messages', body, {
        headers: { Authorization: `Bearer ${input.apiKey}` },
      });
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

interface WhatsappMediaBody {
  contactId: string;
  locationId?: string;
  type: ReplyChannel;
  message: string;
  whatsapp: {
    type: 'media';
    fromNumberId?: string;
    media: {
      type: 'image' | 'document';
      name?: string;
      url: string;
      caption: string;
      mimeType: string;
    };
  };
}

interface FlatSendBody {
  contactId: string;
  message: string;
  type: ReplyChannel;
  attachments?: string[];
}

/**
 * Builds the GHL `POST /conversations/messages` body. WhatsApp image replies
 * use the structured `whatsapp.media` shape (carrying `fromNumberId` when the
 * group provides one); everything else uses the flat `message`/`attachments`
 * shape.
 */
function buildSendBody(input: GhlReplyInput): WhatsappMediaBody | FlatSendBody {
  if (input.whatsappMedia) {
    const { type, name, fromNumberId, url, caption, mimeType } = input.whatsappMedia;
    return {
      contactId: input.contactId,
      ...(input.locationId ? { locationId: input.locationId } : {}),
      type: input.type,
      message: input.message,
      whatsapp: {
        type: 'media',
        ...(fromNumberId ? { fromNumberId } : {}),
        media: { type, ...(name ? { name } : {}), url, caption, mimeType },
      },
    };
  }

  const body: FlatSendBody = {
    contactId: input.contactId,
    message: input.message,
    type: input.type,
  };
  if (input.attachments && input.attachments.length > 0) {
    body.attachments = input.attachments;
  }
  return body;
}

/**
 * Returns the lower-cased file extension of a URL (without the dot), ignoring
 * any query string or fragment. Empty string when there is no extension.
 */
function urlExtension(url: string): string {
  const path = url.split(/[?#]/, 1)[0];
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
}

/**
 * Infers a WhatsApp-acceptable image MIME type from the URL's file extension.
 * Falls back to `image/jpeg` for unknown or extension-less URLs.
 */
export function inferImageMimeType(url: string): string {
  switch (urlExtension(url)) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'jpg':
    case 'jpeg':
    default:
      return 'image/jpeg';
  }
}

const DOCUMENT_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
};

/**
 * Infers a document MIME type from the URL's file extension. Falls back to
 * `application/octet-stream` for unknown or extension-less URLs.
 */
export function inferDocumentMimeType(url: string): string {
  return DOCUMENT_MIME_TYPES[urlExtension(url)] ?? 'application/octet-stream';
}

/**
 * Last path segment of a URL (ignoring query/fragment), used as the document
 * `name` fallback when the chat reply carries no `filename`. Empty string when
 * the URL has no usable segment.
 */
export function basenameFromUrl(url: string): string {
  const path = url.split(/[?#]/, 1)[0];
  const segment = path.slice(path.lastIndexOf('/') + 1);
  return segment;
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
