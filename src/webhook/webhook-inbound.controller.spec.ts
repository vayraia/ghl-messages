import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../config/env.validation';
import { InboundMessagePayloadDto } from './dto/inbound-message-payload.dto';
import { GroupFetcher, GroupSettings } from './group-fetcher';
import { MessageDebouncer } from './message-debouncer';
import { WebhookInboundController } from './webhook-inbound.controller';

interface RedisMock {
  set: jest.Mock;
}

function makeController(
  over: Partial<Record<keyof AppEnv, number>> = {},
  group: Partial<GroupSettings> | Error = {},
) {
  const debouncer = {
    accept: jest.fn().mockResolvedValue({ jobId: 'j_1', pendingCount: 1 }),
  } as unknown as jest.Mocked<MessageDebouncer>;
  const groupFetcher = {
    fetch:
      group instanceof Error
        ? jest.fn().mockRejectedValue(group)
        : jest.fn().mockResolvedValue({ apiKey: 'k', ...group } as GroupSettings),
  } as unknown as jest.Mocked<GroupFetcher>;
  const redis: RedisMock = { set: jest.fn().mockResolvedValue('OK') };
  const env: Record<string, number> = { IDEMPOTENCY_TTL_SECONDS: 3600, ...over };
  const config = {
    get: (k: keyof AppEnv) => env[k as string],
  } as unknown as ConfigService<AppEnv, true>;

  const controller = new WebhookInboundController(debouncer, groupFetcher, redis as never, config);
  return { controller, debouncer, groupFetcher, redis };
}

function payload(over: Partial<InboundMessagePayloadDto> = {}): InboundMessagePayloadDto {
  return {
    type: 'InboundMessage',
    direction: 'inbound',
    status: 'delivered',
    locationId: 'loc_1',
    contactId: 'c_1',
    messageId: 'm_1',
    body: 'hola',
    ...over,
  };
}

describe('WebhookInboundController', () => {
  it('routes a normal inbound DM through the debouncer', async () => {
    const { controller, debouncer } = makeController();
    const r = await controller.inbound(payload());
    expect(r).toEqual({ ok: true, jobId: 'j_1', debounced: false });
    expect(debouncer.accept).toHaveBeenCalled();
  });

  describe('per-group debounce override', () => {
    it('forwards the group debounceMs as delayOverride', async () => {
      const { controller, debouncer } = makeController({}, { debounceMs: 25_000 });
      await controller.inbound(payload());
      expect(debouncer.accept).toHaveBeenCalledWith(
        expect.objectContaining({ delayOverride: 25_000 }),
      );
    });

    it('passes undefined delayOverride when the group has no debounce set', async () => {
      const { controller, debouncer } = makeController({}, {});
      await controller.inbound(payload());
      expect(debouncer.accept).toHaveBeenCalledWith(
        expect.objectContaining({ delayOverride: undefined }),
      );
    });

    it('fail-open: still enqueues (undefined override) when the group fetch throws', async () => {
      const { controller, debouncer } = makeController({}, new Error('chat api down'));
      const r = await controller.inbound(payload());
      expect(r).toEqual({ ok: true, jobId: 'j_1', debounced: false });
      expect(debouncer.accept).toHaveBeenCalledWith(
        expect.objectContaining({ delayOverride: undefined }),
      );
    });
  });

  describe('comment filter', () => {
    it('drops TYPE_TIKTOK_COMMENT (public comment, not a DM)', async () => {
      const { controller, debouncer, redis } = makeController();
      const r = await controller.inbound(
        payload({ messageTypeString: 'TYPE_TIKTOK_COMMENT', messageTypeId: 42 }),
      );
      expect(r).toEqual({ ok: true, skipped: 'comment' });
      expect(debouncer.accept).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('drops TYPE_FACEBOOK_COMMENT', async () => {
      const { controller, debouncer } = makeController();
      const r = await controller.inbound(
        payload({ messageTypeString: 'TYPE_FACEBOOK_COMMENT' }),
      );
      expect(r).toEqual({ ok: true, skipped: 'comment' });
      expect(debouncer.accept).not.toHaveBeenCalled();
    });

    it('drops TYPE_INSTAGRAM_COMMENT', async () => {
      const { controller, debouncer } = makeController();
      const r = await controller.inbound(
        payload({ messageTypeString: 'TYPE_INSTAGRAM_COMMENT' }),
      );
      expect(r).toEqual({ ok: true, skipped: 'comment' });
      expect(debouncer.accept).not.toHaveBeenCalled();
    });

    it('drops when messageType string contains "comment"', async () => {
      const { controller, debouncer } = makeController();
      const r = await controller.inbound(payload({ messageType: 'Instagram Comment' }));
      expect(r).toEqual({ ok: true, skipped: 'comment' });
      expect(debouncer.accept).not.toHaveBeenCalled();
    });

    it('does NOT drop a regular TYPE_TIKTOK DM', async () => {
      const { controller, debouncer } = makeController();
      await controller.inbound(
        payload({ messageTypeString: 'TYPE_TIKTOK', messageTypeId: 41 }),
      );
      expect(debouncer.accept).toHaveBeenCalled();
    });

    it('does NOT drop when neither messageType nor messageTypeString are set', async () => {
      const { controller, debouncer } = makeController();
      await controller.inbound(payload());
      expect(debouncer.accept).toHaveBeenCalled();
    });
  });

  describe('sticker filter', () => {
    it('drops a sticker-only message (empty body + .webp attachment)', async () => {
      const { controller, debouncer, redis } = makeController();
      const r = await controller.inbound(
        payload({ body: '', attachments: ['https://cdn.ghl.com/s/abc.webp'] }),
      );
      expect(r).toEqual({ ok: true, skipped: 'sticker' });
      expect(debouncer.accept).not.toHaveBeenCalled();
      // Runs before idempotency, so no dedup key is burned.
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('drops a real WhatsApp sticker payload', async () => {
      const { controller, debouncer } = makeController();
      const r = await controller.inbound(
        payload({
          messageType: 'WhatsApp',
          messageTypeString: 'TYPE_WHATSAPP',
          messageTypeId: 19,
          contentType: 'text/plain',
          body: '',
          attachments: [
            'https://static-assets.internal.usercontent.site/conversations-assets/location/fAnUgQDSzKBFYTEHyvKK/conversations/eG52zepvVavnZEcusgrD/2e829bc0-8d3a-443a-a29d-a7d8d7416572.webp',
          ],
        }),
      );
      expect(r).toEqual({ ok: true, skipped: 'sticker' });
      expect(debouncer.accept).not.toHaveBeenCalled();
    });

    it('drops a .webp with a query string', async () => {
      const { controller, debouncer } = makeController();
      const r = await controller.inbound(
        payload({ body: '', attachments: ['https://cdn.ghl.com/s/abc.webp?token=xyz'] }),
      );
      expect(r).toEqual({ ok: true, skipped: 'sticker' });
      expect(debouncer.accept).not.toHaveBeenCalled();
    });

    it('does NOT drop a normal image-only message (.jpeg)', async () => {
      const { controller, debouncer } = makeController();
      await controller.inbound(
        payload({ body: '', attachments: ['https://cdn.ghl.com/s/photo.jpeg'] }),
      );
      expect(debouncer.accept).toHaveBeenCalled();
    });

    it('does NOT drop a .webp sent alongside text', async () => {
      const { controller, debouncer } = makeController();
      await controller.inbound(
        payload({ body: 'mira esto', attachments: ['https://cdn.ghl.com/s/abc.webp'] }),
      );
      expect(debouncer.accept).toHaveBeenCalled();
    });

    it('does NOT drop when a .webp is mixed with a non-webp attachment', async () => {
      const { controller, debouncer } = makeController();
      await controller.inbound(
        payload({
          body: '',
          attachments: ['https://cdn.ghl.com/s/abc.webp', 'https://cdn.ghl.com/s/photo.jpeg'],
        }),
      );
      expect(debouncer.accept).toHaveBeenCalled();
    });
  });

  describe('stale-event guard (INBOUND_MAX_AGE_SECONDS)', () => {
    it('drops an event older than the configured max age (GHL sync replay)', async () => {
      const { controller, debouncer, redis } = makeController({ INBOUND_MAX_AGE_SECONDS: 600 });
      const r = await controller.inbound(payload({ dateAdded: '2026-03-05T11:12:09.000Z' }));
      expect(r).toEqual({ ok: true, skipped: 'stale' });
      expect(debouncer.accept).not.toHaveBeenCalled();
      // Stale check runs before idempotency, so no dedup key is burned.
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('processes a fresh event (dateAdded within the window)', async () => {
      const { controller, debouncer } = makeController({ INBOUND_MAX_AGE_SECONDS: 600 });
      await controller.inbound(payload({ dateAdded: new Date().toISOString() }));
      expect(debouncer.accept).toHaveBeenCalled();
    });

    it('fail-open: processes when dateAdded is missing', async () => {
      const { controller, debouncer } = makeController({ INBOUND_MAX_AGE_SECONDS: 600 });
      await controller.inbound(payload());
      expect(debouncer.accept).toHaveBeenCalled();
    });

    it('fail-open: processes when dateAdded is unparseable', async () => {
      const { controller, debouncer } = makeController({ INBOUND_MAX_AGE_SECONDS: 600 });
      await controller.inbound(payload({ dateAdded: 'not-a-date' }));
      expect(debouncer.accept).toHaveBeenCalled();
    });

    it('fail-open: processes a future dateAdded (clock skew)', async () => {
      const { controller, debouncer } = makeController({ INBOUND_MAX_AGE_SECONDS: 600 });
      const future = new Date(Date.now() + 60_000).toISOString();
      await controller.inbound(payload({ dateAdded: future }));
      expect(debouncer.accept).toHaveBeenCalled();
    });

    it('guard off (0): processes even a very old event', async () => {
      const { controller, debouncer } = makeController({ INBOUND_MAX_AGE_SECONDS: 0 });
      await controller.inbound(payload({ dateAdded: '2020-01-01T00:00:00.000Z' }));
      expect(debouncer.accept).toHaveBeenCalled();
    });
  });
});
