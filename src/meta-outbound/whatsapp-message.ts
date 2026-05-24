/**
 * Internal, channel-agnostic representation of an outbound WhatsApp message and
 * the mapper that turns it into the WhatsApp Cloud API request body.
 *
 * Keeping a clean internal union (instead of hand-building Cloud API JSON at the
 * call site) lets callers — the AI pipeline, the send endpoint — express intent
 * ("send these 3 reply buttons") without knowing Meta's wire format, and lets
 * us validate Meta's hard limits up front so a malformed message is rejected
 * before it is ever enqueued or sent.
 *
 * Cloud API reference:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */

// --- Meta's documented limits (reject locally rather than round-trip a 400) ---
const TEXT_BODY_MAX = 4096;
const CAPTION_MAX = 1024;
const REPLY_BUTTONS_MAX = 3;
const BUTTON_TITLE_MAX = 20;
const BUTTON_ID_MAX = 256;
const LIST_ROWS_MAX = 10;
const LIST_BUTTON_MAX = 20;
const SECTION_TITLE_MAX = 24;
const ROW_TITLE_MAX = 24;
const ROW_DESCRIPTION_MAX = 72;
const ROW_ID_MAX = 200;

export type WaHeader =
  | { type: 'text'; text: string }
  | { type: 'image'; link: string }
  | { type: 'video'; link: string }
  | { type: 'document'; link: string; filename?: string };

export interface WaReplyButton {
  id: string;
  title: string;
}

export interface WaListRow {
  id: string;
  title: string;
  description?: string;
}

export interface WaListSection {
  title: string;
  rows: WaListRow[];
}

/**
 * Everything the WhatsApp Cloud API supports for outbound sending. `to` is kept
 * out of here (it's a transport concern passed to {@link buildSendBody}).
 */
export type WaOutboundMessage =
  | { type: 'text'; body: string; previewUrl?: boolean }
  | { type: 'image'; link: string; caption?: string }
  | { type: 'document'; link: string; filename?: string; caption?: string }
  | { type: 'audio'; link: string }
  | { type: 'video'; link: string; caption?: string }
  | { type: 'buttons'; body: string; buttons: WaReplyButton[]; header?: WaHeader; footer?: string }
  | {
      type: 'list';
      body: string;
      button: string;
      sections: WaListSection[];
      header?: string;
      footer?: string;
    }
  | { type: 'template'; name: string; language: string; components?: unknown[] };

export interface CloudApiSendBody {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: string;
  [key: string]: unknown;
}

/**
 * Thrown when a message violates a Cloud API limit. Callers map this to a 400
 * (controller) / non-retryable failure (worker) — retrying never helps.
 */
export class WaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaValidationError';
  }
}

/**
 * Validates and maps an internal message to the full Cloud API request body for
 * `POST /{phone_number_id}/messages`. Throws {@link WaValidationError} on any
 * limit violation.
 */
export function buildSendBody(to: string, msg: WaOutboundMessage): CloudApiSendBody {
  if (!to || to.trim().length === 0) {
    throw new WaValidationError('recipient "to" must not be empty');
  }
  const base = {
    messaging_product: 'whatsapp' as const,
    recipient_type: 'individual' as const,
    to,
  };

  switch (msg.type) {
    case 'text':
      return { ...base, type: 'text', text: buildText(msg.body, msg.previewUrl) };
    case 'image':
      return { ...base, type: 'image', image: buildMedia(msg.link, { caption: msg.caption }) };
    case 'document':
      return {
        ...base,
        type: 'document',
        document: buildMedia(msg.link, { caption: msg.caption, filename: msg.filename }),
      };
    case 'audio':
      return { ...base, type: 'audio', audio: buildMedia(msg.link) };
    case 'video':
      return { ...base, type: 'video', video: buildMedia(msg.link, { caption: msg.caption }) };
    case 'buttons':
      return { ...base, type: 'interactive', interactive: buildButtons(msg) };
    case 'list':
      return { ...base, type: 'interactive', interactive: buildList(msg) };
    case 'template':
      return { ...base, type: 'template', template: buildTemplate(msg) };
    default: {
      // Exhaustiveness guard — a new union member must be handled above.
      const exhaustive: never = msg;
      throw new WaValidationError(`Unsupported message type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function buildText(body: string, previewUrl?: boolean): Record<string, unknown> {
  const trimmed = typeof body === 'string' ? body : '';
  if (trimmed.length === 0) throw new WaValidationError('text.body must not be empty');
  if (trimmed.length > TEXT_BODY_MAX) {
    throw new WaValidationError(`text.body exceeds ${TEXT_BODY_MAX} characters`);
  }
  return { body: trimmed, ...(previewUrl !== undefined ? { preview_url: previewUrl } : {}) };
}

function buildMedia(
  link: string,
  extra: { caption?: string; filename?: string } = {},
): Record<string, unknown> {
  if (!link || link.trim().length === 0) {
    throw new WaValidationError('media link must not be empty');
  }
  if (extra.caption !== undefined && extra.caption.length > CAPTION_MAX) {
    throw new WaValidationError(`caption exceeds ${CAPTION_MAX} characters`);
  }
  return {
    link,
    ...(extra.caption !== undefined ? { caption: extra.caption } : {}),
    ...(extra.filename !== undefined ? { filename: extra.filename } : {}),
  };
}

function buildButtons(msg: {
  body: string;
  buttons: WaReplyButton[];
  header?: WaHeader;
  footer?: string;
}): Record<string, unknown> {
  if (!Array.isArray(msg.buttons) || msg.buttons.length === 0) {
    throw new WaValidationError('buttons message requires at least one button');
  }
  if (msg.buttons.length > REPLY_BUTTONS_MAX) {
    throw new WaValidationError(`a maximum of ${REPLY_BUTTONS_MAX} reply buttons is allowed`);
  }
  const ids = new Set<string>();
  const buttons = msg.buttons.map((b) => {
    if (!b.id || b.id.length === 0 || b.id.length > BUTTON_ID_MAX) {
      throw new WaValidationError(`button id must be 1..${BUTTON_ID_MAX} characters`);
    }
    if (!b.title || b.title.length === 0 || b.title.length > BUTTON_TITLE_MAX) {
      throw new WaValidationError(`button title must be 1..${BUTTON_TITLE_MAX} characters`);
    }
    if (ids.has(b.id)) throw new WaValidationError(`duplicate button id: ${b.id}`);
    ids.add(b.id);
    return { type: 'reply', reply: { id: b.id, title: b.title } };
  });

  return {
    type: 'button',
    ...(msg.header ? { header: buildHeader(msg.header) } : {}),
    body: { text: requireBody(msg.body) },
    ...(msg.footer ? { footer: { text: msg.footer } } : {}),
    action: { buttons },
  };
}

function buildList(msg: {
  body: string;
  button: string;
  sections: WaListSection[];
  header?: string;
  footer?: string;
}): Record<string, unknown> {
  if (!msg.button || msg.button.length === 0 || msg.button.length > LIST_BUTTON_MAX) {
    throw new WaValidationError(`list button label must be 1..${LIST_BUTTON_MAX} characters`);
  }
  if (!Array.isArray(msg.sections) || msg.sections.length === 0) {
    throw new WaValidationError('list message requires at least one section');
  }

  let rowCount = 0;
  const sections = msg.sections.map((s) => {
    if (s.title !== undefined && s.title.length > SECTION_TITLE_MAX) {
      throw new WaValidationError(`section title exceeds ${SECTION_TITLE_MAX} characters`);
    }
    if (!Array.isArray(s.rows) || s.rows.length === 0) {
      throw new WaValidationError('each list section requires at least one row');
    }
    const rows = s.rows.map((r) => {
      rowCount += 1;
      if (!r.id || r.id.length === 0 || r.id.length > ROW_ID_MAX) {
        throw new WaValidationError(`row id must be 1..${ROW_ID_MAX} characters`);
      }
      if (!r.title || r.title.length === 0 || r.title.length > ROW_TITLE_MAX) {
        throw new WaValidationError(`row title must be 1..${ROW_TITLE_MAX} characters`);
      }
      if (r.description !== undefined && r.description.length > ROW_DESCRIPTION_MAX) {
        throw new WaValidationError(`row description exceeds ${ROW_DESCRIPTION_MAX} characters`);
      }
      return {
        id: r.id,
        title: r.title,
        ...(r.description !== undefined ? { description: r.description } : {}),
      };
    });
    return { title: s.title, rows };
  });

  if (rowCount > LIST_ROWS_MAX) {
    throw new WaValidationError(
      `a list may contain at most ${LIST_ROWS_MAX} rows (got ${rowCount})`,
    );
  }

  return {
    type: 'list',
    ...(msg.header ? { header: { type: 'text', text: msg.header } } : {}),
    body: { text: requireBody(msg.body) },
    ...(msg.footer ? { footer: { text: msg.footer } } : {}),
    action: { button: msg.button, sections },
  };
}

function buildHeader(header: WaHeader): Record<string, unknown> {
  switch (header.type) {
    case 'text':
      return { type: 'text', text: header.text };
    case 'image':
      return { type: 'image', image: { link: header.link } };
    case 'video':
      return { type: 'video', video: { link: header.link } };
    case 'document':
      return {
        type: 'document',
        document: {
          link: header.link,
          ...(header.filename !== undefined ? { filename: header.filename } : {}),
        },
      };
  }
}

function buildTemplate(msg: {
  name: string;
  language: string;
  components?: unknown[];
}): Record<string, unknown> {
  if (!msg.name || msg.name.length === 0) {
    throw new WaValidationError('template name must not be empty');
  }
  if (!msg.language || msg.language.length === 0) {
    throw new WaValidationError('template language must not be empty');
  }
  return {
    name: msg.name,
    language: { code: msg.language },
    ...(msg.components ? { components: msg.components } : {}),
  };
}

function requireBody(body: string): string {
  if (!body || body.length === 0) {
    throw new WaValidationError('interactive message body must not be empty');
  }
  if (body.length > TEXT_BODY_MAX) {
    throw new WaValidationError(`interactive body exceeds ${TEXT_BODY_MAX} characters`);
  }
  return body;
}
