import { InboundMessagePayloadDto } from './dto/inbound-message-payload.dto';
import { WebhookPayloadDto } from './dto/webhook-payload.dto';

/**
 * Reply channel — must be one of the values accepted by GHL's
 * `POST /conversations/messages` `type` enum (see SendMessageBodyDto in
 * apps/conversations.json). Whichever value we pick here is forwarded
 * verbatim to GHL by `GhlReply.send`.
 */
export type ReplyChannel =
  | 'SMS'
  | 'RCS'
  | 'Email'
  | 'WhatsApp'
  | 'IG'
  | 'FB'
  | 'Custom'
  | 'Live_Chat'
  | 'TIKTOK';

/**
 * GHL Workflow webhooks send `message.type` as a numeric code (positional in
 * the public Conversations `lastMessageType` enum, 1-indexed). We map only
 * the codes empirically observed in production payloads. Other inbound types
 * (SMS, Email, Call, Review, etc.) fall through to the next resolution step
 * since GHL does not document this mapping and reordering would silently
 * break it.
 *
 * Reference: https://github.com/GoHighLevel/highlevel-api-docs (apps/conversations.json).
 */
const NUMERIC_TYPE_TO_CHANNEL: Record<number, ReplyChannel> = {
  11: 'FB',
  18: 'IG',
  19: 'WhatsApp',
  32: 'FB',
  33: 'IG',
  41: 'TIKTOK',
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

/**
 * Channel resolver for the native GHL `InboundMessage` webhook payload.
 *
 * Priority:
 *  1. `messageType` string (e.g. "WhatsApp", "Instagram", "Facebook").
 *  2. `messageTypeId` numeric — same enum mapping used for the workflow path.
 *  3. Default → WhatsApp.
 */
export function resolveInboundChannel(payload: InboundMessagePayloadDto): ReplyChannel {
  const stringMatch =
    matchString(payload.messageType) ?? matchString(payload.messageTypeString);
  if (stringMatch) return stringMatch;

  if (typeof payload.messageTypeId === 'number') {
    const numericMatch = NUMERIC_TYPE_TO_CHANNEL[payload.messageTypeId];
    if (numericMatch) return numericMatch;
  }

  return 'WhatsApp';
}

function matchString(raw: string | undefined): ReplyChannel | undefined {
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (!v) return undefined;
  // Order matters: more specific tokens must come before generic ones
  // (e.g. 'custom' beats 'sms' so TYPE_CUSTOM_SMS resolves to 'Custom').
  if (v.includes('tiktok')) return 'TIKTOK';
  if (v.includes('whatsapp')) return 'WhatsApp';
  if (v.includes('instagram') || v === 'ig') return 'IG';
  if (v.includes('facebook') || v === 'fb') return 'FB';
  if (v.includes('live') || v.includes('webchat')) return 'Live_Chat';
  if (v.includes('custom')) return 'Custom';
  if (v.includes('email')) return 'Email';
  if (v.includes('rcs')) return 'RCS';
  if (v.includes('sms')) return 'SMS';
  return undefined;
}
