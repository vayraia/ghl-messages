/**
 * Extracts a tenant key + summary fields from a Meta webhook payload.
 *
 * A single POST batch can carry events for many tenants (the `entry[]`
 * array). Each event is normalized into a flat record for logging:
 *
 *   {
 *     tenantKey,      // "page:<id>" | "ig:<id>" | "wa:<phone_number_id>"
 *     entryId,        // raw entry.id (Page / IG account / WABA)
 *     kind,           // "message" | "status" | "echo" | "postback" |
 *                     // "reaction" | "comment" | "change" | "unknown"
 *     sender,         // PSID / IGSID / phone number (when available)
 *     recipient,      // page id / ig id / phone_number_id (when available)
 *     timestamp,      // event timestamp in epoch ms when available
 *     messageType,    // text / image / audio / video / etc.
 *     hasText,        // boolean — content sample omitted on purpose
 *     displayPhone,   // WhatsApp only
 *   }
 *
 * Designed for the log-only phase: it never throws on malformed payloads,
 * it returns the events it could parse and silently skips anything it
 * doesn't recognize. Callers can log `events.length` vs `entries` to spot
 * shapes we don't handle yet.
 */
export type MetaObjectType =
  | 'page'
  | 'instagram'
  | 'whatsapp_business_account'
  | 'unknown';

export interface MetaEventSummary {
  tenantKey: string;
  entryId?: string;
  kind:
    | 'message'
    | 'status'
    | 'echo'
    | 'postback'
    | 'reaction'
    | 'comment'
    | 'change'
    | 'unknown';
  sender?: string;
  recipient?: string;
  timestamp?: number;
  messageType?: string;
  hasText?: boolean;
  displayPhone?: string;
}

export interface MetaSummary {
  object: MetaObjectType;
  entries: number;
  events: MetaEventSummary[];
}

export function summarizeMetaPayload(payload: unknown): MetaSummary {
  if (!isRecord(payload)) {
    return { object: 'unknown', entries: 0, events: [] };
  }

  const object = normalizeObject(payload.object);
  const entry = Array.isArray(payload.entry) ? payload.entry : [];
  const events: MetaEventSummary[] = [];

  for (const e of entry) {
    if (!isRecord(e)) continue;
    const entryId = typeof e.id === 'string' ? e.id : undefined;

    if (object === 'page' || object === 'instagram') {
      const tenantKey = entryId
        ? `${object === 'page' ? 'page' : 'ig'}:${entryId}`
        : `${object === 'page' ? 'page' : 'ig'}:unknown`;
      collectMessengerEvents(e, tenantKey, entryId, events);
    } else if (object === 'whatsapp_business_account') {
      collectWhatsAppEvents(e, entryId, events);
    } else {
      events.push({
        tenantKey: entryId ? `unknown:${entryId}` : 'unknown',
        entryId,
        kind: 'unknown',
      });
    }
  }

  return { object, entries: entry.length, events };
}

function collectMessengerEvents(
  entry: Record<string, unknown>,
  tenantKey: string,
  entryId: string | undefined,
  out: MetaEventSummary[],
): void {
  const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
  if (messaging.length === 0) {
    // Could be a `changes[]` payload (e.g. IG comments, FB feed). Surface
    // them as a single 'change' event so the log shows we received them.
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const _ of changes) {
      out.push({ tenantKey, entryId, kind: 'change' });
    }
    return;
  }

  for (const m of messaging) {
    if (!isRecord(m)) continue;
    const sender = readId(m.sender);
    const recipient = readId(m.recipient);
    const timestamp = typeof m.timestamp === 'number' ? m.timestamp : undefined;

    if (isRecord(m.message)) {
      const msg = m.message;
      const isEcho = msg.is_echo === true;
      const text = typeof msg.text === 'string' ? msg.text : undefined;
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      const messageType =
        attachments.length > 0
          ? readAttachmentType(attachments[0])
          : text !== undefined
            ? 'text'
            : undefined;
      out.push({
        tenantKey,
        entryId,
        kind: isEcho ? 'echo' : 'message',
        sender,
        recipient,
        timestamp,
        messageType,
        hasText: typeof text === 'string' && text.length > 0,
      });
      continue;
    }
    if (isRecord(m.postback)) {
      out.push({ tenantKey, entryId, kind: 'postback', sender, recipient, timestamp });
      continue;
    }
    if (isRecord(m.reaction)) {
      out.push({ tenantKey, entryId, kind: 'reaction', sender, recipient, timestamp });
      continue;
    }
    out.push({ tenantKey, entryId, kind: 'unknown', sender, recipient, timestamp });
  }
}

function collectWhatsAppEvents(
  entry: Record<string, unknown>,
  entryId: string | undefined,
  out: MetaEventSummary[],
): void {
  const changes = Array.isArray(entry.changes) ? entry.changes : [];
  for (const change of changes) {
    if (!isRecord(change)) continue;
    const value = isRecord(change.value) ? change.value : undefined;
    if (!value) continue;

    const metadata = isRecord(value.metadata) ? value.metadata : undefined;
    const phoneNumberId =
      metadata && typeof metadata.phone_number_id === 'string'
        ? metadata.phone_number_id
        : undefined;
    const displayPhone =
      metadata && typeof metadata.display_phone_number === 'string'
        ? metadata.display_phone_number
        : undefined;

    const tenantKey = phoneNumberId ? `wa:${phoneNumberId}` : 'wa:unknown';

    const messages = Array.isArray(value.messages) ? value.messages : [];
    for (const m of messages) {
      if (!isRecord(m)) continue;
      const from = typeof m.from === 'string' ? m.from : undefined;
      const messageType = typeof m.type === 'string' ? m.type : undefined;
      const timestamp = parseWhatsAppTimestamp(m.timestamp);
      const hasText =
        isRecord(m.text) && typeof m.text.body === 'string' && m.text.body.length > 0;
      out.push({
        tenantKey,
        entryId,
        kind: 'message',
        sender: from,
        recipient: phoneNumberId,
        timestamp,
        messageType,
        hasText,
        displayPhone,
      });
    }

    const statuses = Array.isArray(value.statuses) ? value.statuses : [];
    for (const s of statuses) {
      if (!isRecord(s)) continue;
      const recipientId = typeof s.recipient_id === 'string' ? s.recipient_id : undefined;
      const timestamp = parseWhatsAppTimestamp(s.timestamp);
      const status = typeof s.status === 'string' ? s.status : undefined;
      out.push({
        tenantKey,
        entryId,
        kind: 'status',
        recipient: recipientId,
        sender: phoneNumberId,
        timestamp,
        messageType: status,
        displayPhone,
      });
    }

    if (messages.length === 0 && statuses.length === 0) {
      out.push({ tenantKey, entryId, kind: 'change', sender: phoneNumberId, displayPhone });
    }
  }
}

function normalizeObject(value: unknown): MetaObjectType {
  if (value === 'page' || value === 'instagram' || value === 'whatsapp_business_account') {
    return value;
  }
  return 'unknown';
}

function readId(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.id === 'string') return value.id;
  return undefined;
}

function readAttachmentType(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.type === 'string') return value.type;
  return undefined;
}

// WhatsApp Cloud API sends timestamp as a string of unix seconds.
function parseWhatsAppTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
