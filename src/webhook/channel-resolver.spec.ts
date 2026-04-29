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

  it('uses customData.channel when present', () => {
    expect(resolveReplyChannel(payload({ customData: { channel: 'FB' } }))).toBe('FB');
  });

  it('customData.channel overrides attribution source', () => {
    expect(
      resolveReplyChannel(
        payload({
          customData: { channel: 'WhatsApp' },
          contact: { lastAttributionSource: { medium: 'instagram' } },
        }),
      ),
    ).toBe('WhatsApp');
  });

  it('uses string message.type when present', () => {
    expect(resolveReplyChannel(payload({ message: { type: 'whatsapp', body: 'hi' } }))).toBe(
      'WhatsApp',
    );
  });

  it('maps numeric message.type 19 to WhatsApp', () => {
    expect(resolveReplyChannel(payload({ message: { type: 19, body: 'hi' } }))).toBe('WhatsApp');
  });

  it('maps numeric message.type 18 to IG', () => {
    expect(resolveReplyChannel(payload({ message: { type: 18, body: 'hi' } }))).toBe('IG');
  });

  it('maps numeric message.type 11 to FB', () => {
    expect(resolveReplyChannel(payload({ message: { type: 11, body: 'hi' } }))).toBe('FB');
  });

  it('numeric message.type overrides attribution source', () => {
    expect(
      resolveReplyChannel(
        payload({
          message: { type: 19, body: 'hi' },
          contact: { lastAttributionSource: { medium: 'instagram' } },
        }),
      ),
    ).toBe('WhatsApp');
  });

  it('falls through to attribution when numeric type is unknown', () => {
    expect(
      resolveReplyChannel(
        payload({
          message: { type: 2, body: 'hi' },
          contact: { lastAttributionSource: { medium: 'instagram' } },
        }),
      ),
    ).toBe('IG');
  });

  it('returns WhatsApp default when none of the hints match a known channel', () => {
    expect(
      resolveReplyChannel(payload({ contact: { lastAttributionSource: { medium: 'sms' } } })),
    ).toBe('WhatsApp');
  });
});
