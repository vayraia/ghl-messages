import { resolveReplyChannel } from './channel-resolver';
import { WebhookPayloadDto } from './dto/webhook-payload.dto';

function payload(overrides: Partial<WebhookPayloadDto>): WebhookPayloadDto {
  return {
    agent_id: 'ventas',
    contact_id: 'c-1',
    ...overrides,
  } as WebhookPayloadDto;
}

describe('resolveReplyChannel', () => {
  it('defaults to WhatsApp when no hints are present', () => {
    expect(resolveReplyChannel(payload({}))).toBe('WhatsApp');
  });

  it('detects WhatsApp from lastAttributionSource', () => {
    expect(
      resolveReplyChannel(
        payload({ contact: { lastAttributionSource: { medium: 'WhatsApp web' } } }),
      ),
    ).toBe('WhatsApp');
  });

  it('detects IG from instagram in lastAttributionSource', () => {
    expect(
      resolveReplyChannel(payload({ contact: { lastAttributionSource: { medium: 'instagram' } } })),
    ).toBe('IG');
  });

  it('detects FB from facebook in lastAttributionSource', () => {
    expect(
      resolveReplyChannel(payload({ contact: { lastAttributionSource: { medium: 'facebook' } } })),
    ).toBe('FB');
  });

  it('falls through to attributionSource when last is empty', () => {
    expect(
      resolveReplyChannel(
        payload({
          contact: {
            lastAttributionSource: { medium: '' },
            attributionSource: { medium: 'Instagram DM' },
          },
        }),
      ),
    ).toBe('IG');
  });

  it('uses customData.channel as fallback', () => {
    expect(resolveReplyChannel(payload({ customData: { channel: 'FB' } }))).toBe('FB');
  });

  it('uses message.type as last resort', () => {
    expect(resolveReplyChannel(payload({ message: { type: 'whatsapp', body: 'hi' } }))).toBe(
      'WhatsApp',
    );
  });

  it('returns WhatsApp default when none of the hints match a known channel', () => {
    expect(
      resolveReplyChannel(payload({ contact: { lastAttributionSource: { medium: 'sms' } } })),
    ).toBe('WhatsApp');
  });
});
