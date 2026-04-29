import { WebhookPayloadDto } from './dto/webhook-payload.dto';

export type ReplyChannel = 'WhatsApp' | 'IG' | 'FB';

/**
 * GHL Workflow webhooks send `message.type` as a numeric code (positional in
 * the public Conversations OpenAPI enum, 1-indexed). We only map the codes
 * that correspond to channels we can reply on (WhatsApp / IG / FB). Codes
 * for SMS, Email, Call, etc. are intentionally absent — they fall through
 * to the next resolution step.
 *
 * Reference: https://github.com/GoHighLevel/highlevel-api-docs (apps/conversations.json,
 * `lastMessageType` enum). The numeric mapping is derived from enum position;
 * GHL does not document it explicitly so this may break if they reorder.
 */
const NUMERIC_TYPE_TO_CHANNEL: Record<number, ReplyChannel> = {
  11: 'FB',
  18: 'IG',
  19: 'WhatsApp',
  32: 'FB',
  33: 'IG',
};

/**
 * Decide which messaging channel GHL should use to deliver the reply.
 *
 * Priority (most reliable first):
 *  1. `customData.channel` — explicit override set by the GHL workflow.
 *  2. `message.type` — channel of the actual inbound message; accepts
 *     numeric GHL codes or string aliases.
 *  3. `contact.lastAttributionSource.medium` — marketing attribution
 *     fallback (NOT necessarily the current message channel).
 *  4. `contact.attributionSource.medium` — same as above.
 *
 * Default → WhatsApp. Strings are matched case-insensitively against
 * known substrings (`whatsapp`, `instagram`/`ig`, `facebook`/`fb`).
 */
export function resolveReplyChannel(payload: WebhookPayloadDto): ReplyChannel {
  const customDataMatch = matchString(payload.customData?.channel);
  if (customDataMatch) return customDataMatch;

  const messageType = payload.message?.type;
  if (typeof messageType === 'number') {
    const numericMatch = NUMERIC_TYPE_TO_CHANNEL[messageType];
    if (numericMatch) return numericMatch;
  } else {
    const stringMatch = matchString(messageType);
    if (stringMatch) return stringMatch;
  }

  const lastAttrMatch = matchString(payload.contact?.lastAttributionSource?.medium);
  if (lastAttrMatch) return lastAttrMatch;

  const attrMatch = matchString(payload.contact?.attributionSource?.medium);
  if (attrMatch) return attrMatch;

  return 'WhatsApp';
}

function matchString(raw: string | undefined): ReplyChannel | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (!v) return undefined;
  if (v.includes('whatsapp')) return 'WhatsApp';
  if (v.includes('instagram') || v === 'ig') return 'IG';
  if (v.includes('facebook') || v === 'fb') return 'FB';
  return undefined;
}
