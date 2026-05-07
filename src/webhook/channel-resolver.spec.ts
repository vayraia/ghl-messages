import { resolveInboundChannel, resolveReplyChannel } from './channel-resolver';
import { InboundMessagePayloadDto } from './dto/inbound-message-payload.dto';
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
      resolveReplyChannel(payload({ contact: { lastAttributionSource: { medium: 'pigeon' } } })),
    ).toBe('WhatsApp');
  });

  it('detects SMS from medium "sms"', () => {
    expect(
      resolveReplyChannel(payload({ contact: { lastAttributionSource: { medium: 'sms' } } })),
    ).toBe('SMS');
  });

  it('detects Email from medium "email"', () => {
    expect(
      resolveReplyChannel(payload({ contact: { lastAttributionSource: { medium: 'email' } } })),
    ).toBe('Email');
  });

  it('detects RCS from medium "rcs"', () => {
    expect(
      resolveReplyChannel(payload({ contact: { lastAttributionSource: { medium: 'rcs' } } })),
    ).toBe('RCS');
  });

  it('detects Live_Chat from medium "live chat"', () => {
    expect(
      resolveReplyChannel(payload({ contact: { lastAttributionSource: { medium: 'live chat' } } })),
    ).toBe('Live_Chat');
  });

  it('detects Live_Chat from medium "webchat"', () => {
    expect(
      resolveReplyChannel(payload({ contact: { lastAttributionSource: { medium: 'webchat' } } })),
    ).toBe('Live_Chat');
  });

  it('detects Custom from medium "custom"', () => {
    expect(
      resolveReplyChannel(payload({ contact: { lastAttributionSource: { medium: 'custom' } } })),
    ).toBe('Custom');
  });

  it('detects TIKTOK from medium "tiktok"', () => {
    expect(
      resolveReplyChannel(payload({ contact: { lastAttributionSource: { medium: 'tiktok' } } })),
    ).toBe('TIKTOK');
  });

  it('routes TYPE_CUSTOM_SMS to Custom (not SMS) — custom wins over sms', () => {
    expect(
      resolveReplyChannel(payload({ message: { type: 'TYPE_CUSTOM_SMS', body: 'hi' } })),
    ).toBe('Custom');
  });

  it('routes TYPE_TIKTOK to TIKTOK from string message.type', () => {
    expect(resolveReplyChannel(payload({ message: { type: 'TYPE_TIKTOK', body: 'hi' } }))).toBe(
      'TIKTOK',
    );
  });

  it('maps numeric message.type 41 to TIKTOK', () => {
    expect(resolveReplyChannel(payload({ message: { type: 41, body: 'hi' } }))).toBe('TIKTOK');
  });
});

describe('resolveInboundChannel', () => {
  function inbound(over: Partial<InboundMessagePayloadDto>): InboundMessagePayloadDto {
    return { ...over } as InboundMessagePayloadDto;
  }

  it('defaults to WhatsApp when no fields are present', () => {
    expect(resolveInboundChannel(inbound({}))).toBe('WhatsApp');
  });

  it('uses messageType string when present', () => {
    expect(resolveInboundChannel(inbound({ messageType: 'WhatsApp' }))).toBe('WhatsApp');
  });

  it('falls back to messageTypeString when messageType is missing', () => {
    expect(resolveInboundChannel(inbound({ messageTypeString: 'TYPE_TIKTOK' }))).toBe('TIKTOK');
  });

  it('maps messageTypeId 41 to TIKTOK', () => {
    expect(resolveInboundChannel(inbound({ messageTypeId: 41 }))).toBe('TIKTOK');
  });

  it('maps messageTypeId 19 to WhatsApp', () => {
    expect(resolveInboundChannel(inbound({ messageTypeId: 19 }))).toBe('WhatsApp');
  });

  it('falls through to default when messageTypeId is unknown', () => {
    expect(resolveInboundChannel(inbound({ messageTypeId: 999 }))).toBe('WhatsApp');
  });

  it('messageType string takes priority over messageTypeId', () => {
    expect(
      resolveInboundChannel(inbound({ messageType: 'Instagram', messageTypeId: 41 })),
    ).toBe('IG');
  });

  it('messageTypeString takes priority over messageTypeId', () => {
    expect(
      resolveInboundChannel(inbound({ messageTypeString: 'TYPE_INSTAGRAM', messageTypeId: 41 })),
    ).toBe('IG');
  });
});
