import { WebhookPayloadDto } from './dto/webhook-payload.dto';

export type ReplyChannel = 'WhatsApp' | 'IG' | 'FB';

/**
 * Decide which messaging channel GHL should use to deliver the reply.
 *
 * Priority:
 *  1. `contact.lastAttributionSource.medium`
 *  2. `contact.attributionSource.medium`
 *  3. `customData.channel`
 *  4. `message.type`
 *
 * Default → WhatsApp. The channel is matched case-insensitively against
 * known substrings (`whatsapp`, `instagram`/`ig`, `facebook`/`fb`).
 */
export function resolveReplyChannel(payload: WebhookPayloadDto): ReplyChannel {
  const messageType = payload.message?.type;
  const candidates: string[] = [
    payload.contact?.lastAttributionSource?.medium ?? '',
    payload.contact?.attributionSource?.medium ?? '',
    payload.customData?.channel ?? '',
    typeof messageType === 'string' ? messageType : '',
  ];

  for (const raw of candidates) {
    const matched = match(raw);
    if (matched) {
      return matched;
    }
  }

  return 'WhatsApp';
}

function match(raw: string): ReplyChannel | undefined {
  const v = raw.toLowerCase();
  if (!v) return undefined;
  if (v.includes('whatsapp')) return 'WhatsApp';
  if (v.includes('instagram') || v === 'ig') return 'IG';
  if (v.includes('facebook') || v === 'fb') return 'FB';
  return undefined;
}
