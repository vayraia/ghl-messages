import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../config/env.validation';
import { InboundMessagePayloadDto } from './dto/inbound-message-payload.dto';
import { MessageDebouncer } from './message-debouncer';
import { WebhookInboundController } from './webhook-inbound.controller';

interface RedisMock {
  set: jest.Mock;
}

function makeController() {
  const debouncer = {
    accept: jest.fn().mockResolvedValue({ jobId: 'j_1', pendingCount: 1 }),
  } as unknown as jest.Mocked<MessageDebouncer>;
  const redis: RedisMock = { set: jest.fn().mockResolvedValue('OK') };
  const env: Record<string, number> = { IDEMPOTENCY_TTL_SECONDS: 3600 };
  const config = {
    get: (k: keyof AppEnv) => env[k as string],
  } as unknown as ConfigService<AppEnv, true>;

  const controller = new WebhookInboundController(debouncer, redis as never, config);
  return { controller, debouncer, redis };
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
});
