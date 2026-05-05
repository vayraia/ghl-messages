import { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { OutboundWebhookPayloadDto } from './dto/outbound-webhook-payload.dto';
import { GhlContactClient } from './ghl-contact-client';
import { GroupFetcher, GroupSettings } from './group-fetcher';
import { InsistenceClient } from './insistence-client';
import { WebhookOutboundController } from './webhook-outbound.controller';
import { AppEnv } from '../config/env.validation';

interface RedisMock {
  set: jest.Mock;
}

function makeController() {
  const groupFetcher = { fetch: jest.fn() } as unknown as jest.Mocked<GroupFetcher>;
  const updater = {
    disableAiField: jest.fn(),
    get: jest.fn(),
  } as unknown as jest.Mocked<GhlContactClient>;
  const insistenceClient = {
    schedule: jest.fn(),
    cancel: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<InsistenceClient>;
  const redis: RedisMock = { set: jest.fn().mockResolvedValue('OK') };

  const env: Record<string, number> = { IDEMPOTENCY_TTL_SECONDS: 3600 };
  const config = {
    get: (k: keyof AppEnv) => env[k as string],
  } as unknown as ConfigService<AppEnv, true>;

  const controller = new WebhookOutboundController(
    groupFetcher,
    updater,
    insistenceClient,
    redis as never,
    config,
  );

  return { controller, groupFetcher, updater, insistenceClient, redis };
}

function payload(over: Partial<OutboundWebhookPayloadDto> = {}): OutboundWebhookPayloadDto {
  return {
    type: 'OutboundMessage',
    status: 'delivered',
    locationId: 'loc_1',
    contactId: 'c_1',
    messageId: 'm_1',
    userId: 'u_1',
    ...over,
  };
}

describe('WebhookOutboundController', () => {
  it('skips with 200 when type is not OutboundMessage', async () => {
    const { controller, groupFetcher, insistenceClient } = makeController();
    const r = await controller.outbound(payload({ type: 'InboundMessage' }));
    expect(r).toEqual({ ok: true });
    expect(groupFetcher.fetch).not.toHaveBeenCalled();
    expect(insistenceClient.cancel).not.toHaveBeenCalled();
  });

  it('skips with 200 when status is not delivered', async () => {
    const { controller, groupFetcher, insistenceClient } = makeController();
    const r = await controller.outbound(payload({ status: 'sent' }));
    expect(r).toEqual({ ok: true });
    expect(groupFetcher.fetch).not.toHaveBeenCalled();
    expect(insistenceClient.cancel).not.toHaveBeenCalled();
  });

  it('skips with 200 when userId is missing (bot message — not a human takeover)', async () => {
    const { controller, groupFetcher, insistenceClient, redis } = makeController();
    const r = await controller.outbound(payload({ userId: undefined }));
    expect(r).toEqual({ ok: true });
    expect(groupFetcher.fetch).not.toHaveBeenCalled();
    expect(insistenceClient.cancel).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('skips with 200 when locationId is missing', async () => {
    const { controller, groupFetcher, insistenceClient } = makeController();
    const r = await controller.outbound(payload({ locationId: undefined }));
    expect(r).toEqual({ ok: true });
    expect(groupFetcher.fetch).not.toHaveBeenCalled();
    expect(insistenceClient.cancel).not.toHaveBeenCalled();
  });

  it('skips with 200 when contactId is missing', async () => {
    const { controller, groupFetcher, insistenceClient } = makeController();
    const r = await controller.outbound(payload({ contactId: undefined }));
    expect(r).toEqual({ ok: true });
    expect(groupFetcher.fetch).not.toHaveBeenCalled();
    expect(insistenceClient.cancel).not.toHaveBeenCalled();
  });

  it('deduplicates on messageId via Redis SET NX EX', async () => {
    const { controller, groupFetcher, insistenceClient, redis } = makeController();
    redis.set.mockResolvedValueOnce(null);

    const r = await controller.outbound(payload());

    expect(r).toEqual({ ok: true, deduplicated: true });
    expect(redis.set).toHaveBeenCalledWith(
      'webhook:outbound:idem:m_1',
      '1',
      'EX',
      3600,
      'NX',
    );
    expect(groupFetcher.fetch).not.toHaveBeenCalled();
    expect(insistenceClient.cancel).not.toHaveBeenCalled();
  });

  it('skips idempotency check when messageId is missing', async () => {
    const { controller, groupFetcher, updater, redis } = makeController();
    groupFetcher.fetch.mockResolvedValue({
      apiKey: 'sk',
      aiFieldId: { id: 'cf', key: 'ai' },
    } satisfies GroupSettings);
    updater.disableAiField.mockResolvedValue({ status: 200, durationMs: 5 });

    const r = await controller.outbound(payload({ messageId: undefined }));

    expect(redis.set).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, updated: true });
  });

  it('returns skipped=no_ai_field_id when group has no aiFieldId', async () => {
    const { controller, groupFetcher, updater } = makeController();
    groupFetcher.fetch.mockResolvedValue({ apiKey: 'sk' } satisfies GroupSettings);

    const r = await controller.outbound(payload());

    expect(r).toEqual({ ok: true, skipped: 'no_ai_field_id' });
    expect(updater.disableAiField).not.toHaveBeenCalled();
  });

  it('disables AI field with the group apiKey when ai_field_id is configured', async () => {
    const { controller, groupFetcher, updater } = makeController();
    groupFetcher.fetch.mockResolvedValue({
      apiKey: 'sk_xxx',
      aiFieldId: { id: 'cf_1', key: 'ai_status' },
    } satisfies GroupSettings);
    updater.disableAiField.mockResolvedValue({ status: 200, durationMs: 7 });

    const r = await controller.outbound(payload());

    expect(groupFetcher.fetch).toHaveBeenCalledWith('loc_1', 'm_1');
    expect(updater.disableAiField).toHaveBeenCalledWith({
      jobId: 'm_1',
      contactId: 'c_1',
      apiKey: 'sk_xxx',
      aiField: { id: 'cf_1', key: 'ai_status' },
    });
    expect(r).toEqual({ ok: true, updated: true });
  });

  it('swallows UnrecoverableError from groupFetcher and returns 200', async () => {
    const { controller, groupFetcher } = makeController();
    groupFetcher.fetch.mockRejectedValue(new UnrecoverableError('bad config'));

    const r = await controller.outbound(payload());

    expect(r).toEqual({ ok: true });
  });

  it('swallows UnrecoverableError from contactUpdater and returns 200', async () => {
    const { controller, groupFetcher, updater } = makeController();
    groupFetcher.fetch.mockResolvedValue({
      apiKey: 'sk',
      aiFieldId: { id: 'cf', key: 'ai' },
    } satisfies GroupSettings);
    updater.disableAiField.mockRejectedValue(new UnrecoverableError('400 bad'));

    const r = await controller.outbound(payload());

    expect(r).toEqual({ ok: true });
  });

  it('re-throws transient Error so GHL retries the webhook', async () => {
    const { controller, groupFetcher } = makeController();
    groupFetcher.fetch.mockRejectedValue(new Error('upstream 503'));

    await expect(controller.outbound(payload())).rejects.toThrow('upstream 503');
  });

  describe('insistence cancellation', () => {
    it('cancels insistences before fetching the group on a human takeover', async () => {
      const { controller, groupFetcher, updater, insistenceClient } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        aiFieldId: { id: 'cf', key: 'ai' },
      } satisfies GroupSettings);
      updater.disableAiField.mockResolvedValue({ status: 200, durationMs: 1 });

      await controller.outbound(payload());

      expect(insistenceClient.cancel).toHaveBeenCalledWith({
        jobId: 'm_1',
        contactId: 'c_1',
      });
      const cancelOrder = (insistenceClient.cancel as jest.Mock).mock.invocationCallOrder[0];
      const fetchOrder = (groupFetcher.fetch as jest.Mock).mock.invocationCallOrder[0];
      expect(cancelOrder).toBeLessThan(fetchOrder);
    });

    it('continues with disable-AI when cancel rejects unexpectedly', async () => {
      const { controller, groupFetcher, updater, insistenceClient } = makeController();
      (insistenceClient.cancel as jest.Mock).mockRejectedValue(new Error('boom'));
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        aiFieldId: { id: 'cf', key: 'ai' },
      } satisfies GroupSettings);
      updater.disableAiField.mockResolvedValue({ status: 200, durationMs: 1 });

      const r = await controller.outbound(payload());

      expect(r).toEqual({ ok: true, updated: true });
      expect(updater.disableAiField).toHaveBeenCalled();
    });

    it('still cancels even when the group has no aiFieldId', async () => {
      const { controller, groupFetcher, insistenceClient } = makeController();
      groupFetcher.fetch.mockResolvedValue({ apiKey: 'sk' } satisfies GroupSettings);

      const r = await controller.outbound(payload());

      expect(insistenceClient.cancel).toHaveBeenCalledWith({
        jobId: 'm_1',
        contactId: 'c_1',
      });
      expect(r).toEqual({ ok: true, skipped: 'no_ai_field_id' });
    });

    it('uses messageId as jobId when present, otherwise contactId:locationId', async () => {
      const { controller, groupFetcher, insistenceClient } = makeController();
      groupFetcher.fetch.mockResolvedValue({ apiKey: 'sk' } satisfies GroupSettings);

      await controller.outbound(payload({ messageId: undefined }));

      expect(insistenceClient.cancel).toHaveBeenCalledWith({
        jobId: 'c_1:loc_1',
        contactId: 'c_1',
      });
    });
  });
});
