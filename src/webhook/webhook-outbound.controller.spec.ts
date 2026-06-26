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
    updateContactFields: jest.fn(),
    // Default: no field definitions resolved → no aiagent to clear. Individual
    // tests override this to exercise the agent-override clearing.
    listFieldDefs: jest.fn().mockResolvedValue({ idToName: new Map(), keyToId: new Map() }),
    get: jest.fn(),
  } as unknown as jest.Mocked<GhlContactClient>;
  const insistenceClient = {
    schedule: jest.fn(),
    cancel: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<InsistenceClient>;
  const redis: RedisMock = { set: jest.fn().mockResolvedValue('OK') };

  const env: Record<string, number | string> = {
    IDEMPOTENCY_TTL_SECONDS: 3600,
    AGENT_FIELD_KEY: 'contact.aiagent',
  };
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
    updater.updateContactFields.mockResolvedValue({ status: 200, durationMs: 5 });

    const r = await controller.outbound(payload({ messageId: undefined }));

    expect(redis.set).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, updated: true });
  });

  it('returns skipped=nothing_to_update when no aiFieldId and no aiagent field', async () => {
    const { controller, groupFetcher, updater } = makeController();
    groupFetcher.fetch.mockResolvedValue({ apiKey: 'sk' } satisfies GroupSettings);

    const r = await controller.outbound(payload());

    expect(r).toEqual({ ok: true, skipped: 'nothing_to_update' });
    expect(updater.updateContactFields).not.toHaveBeenCalled();
  });

  it('disables the AI field with the group apiKey when ai_field_id is configured', async () => {
    const { controller, groupFetcher, updater } = makeController();
    groupFetcher.fetch.mockResolvedValue({
      apiKey: 'sk_xxx',
      aiFieldId: { id: 'cf_1', key: 'ai_status' },
    } satisfies GroupSettings);
    updater.updateContactFields.mockResolvedValue({ status: 200, durationMs: 7 });

    const r = await controller.outbound(payload());

    expect(groupFetcher.fetch).toHaveBeenCalledWith('loc_1', 'm_1');
    expect(updater.updateContactFields).toHaveBeenCalledWith({
      jobId: 'm_1',
      contactId: 'c_1',
      apiKey: 'sk_xxx',
      fields: [{ id: 'cf_1', key: 'ai_status', value: 'Disabled' }],
    });
    expect(r).toEqual({ ok: true, updated: true });
  });

  describe('aiagent override clearing', () => {
    it('clears aiagent alongside the AI disable in a single update', async () => {
      const { controller, groupFetcher, updater } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk_xxx',
        aiFieldId: { id: 'cf_1', key: 'ai_status' },
      } satisfies GroupSettings);
      updater.listFieldDefs.mockResolvedValue({
        idToName: new Map(),
        keyToId: new Map([['contact.aiagent', 'cf_agent']]),
      });
      updater.updateContactFields.mockResolvedValue({ status: 200, durationMs: 7 });

      const r = await controller.outbound(payload());

      expect(updater.listFieldDefs).toHaveBeenCalledWith({
        jobId: 'm_1',
        locationId: 'loc_1',
        apiKey: 'sk_xxx',
      });
      expect(updater.updateContactFields).toHaveBeenCalledWith({
        jobId: 'm_1',
        contactId: 'c_1',
        apiKey: 'sk_xxx',
        fields: [
          { id: 'cf_1', key: 'ai_status', value: 'Disabled' },
          { id: 'cf_agent', key: 'contact.aiagent', value: '' },
        ],
      });
      expect(r).toEqual({ ok: true, updated: true });
    });

    it('clears aiagent even when the group has no aiFieldId', async () => {
      const { controller, groupFetcher, updater } = makeController();
      groupFetcher.fetch.mockResolvedValue({ apiKey: 'sk' } satisfies GroupSettings);
      updater.listFieldDefs.mockResolvedValue({
        idToName: new Map(),
        keyToId: new Map([['contact.aiagent', 'cf_agent']]),
      });
      updater.updateContactFields.mockResolvedValue({ status: 200, durationMs: 4 });

      const r = await controller.outbound(payload());

      expect(updater.updateContactFields).toHaveBeenCalledWith({
        jobId: 'm_1',
        contactId: 'c_1',
        apiKey: 'sk',
        fields: [{ id: 'cf_agent', key: 'contact.aiagent', value: '' }],
      });
      expect(r).toEqual({ ok: true, updated: true });
    });

    it('still disables the AI field when aiagent def resolution fails', async () => {
      const { controller, groupFetcher, updater } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        aiFieldId: { id: 'cf_1', key: 'ai_status' },
      } satisfies GroupSettings);
      updater.listFieldDefs.mockRejectedValue(new Error('defs 503'));
      updater.updateContactFields.mockResolvedValue({ status: 200, durationMs: 4 });

      const r = await controller.outbound(payload());

      expect(updater.updateContactFields).toHaveBeenCalledWith({
        jobId: 'm_1',
        contactId: 'c_1',
        apiKey: 'sk',
        fields: [{ id: 'cf_1', key: 'ai_status', value: 'Disabled' }],
      });
      expect(r).toEqual({ ok: true, updated: true });
    });
  });

  it('swallows UnrecoverableError from groupFetcher and returns 200', async () => {
    const { controller, groupFetcher, insistenceClient, updater } = makeController();
    groupFetcher.fetch.mockRejectedValue(new UnrecoverableError('bad config'));

    const r = await controller.outbound(payload());

    expect(r).toEqual({ ok: true });
    expect(insistenceClient.cancel).not.toHaveBeenCalled();
    expect(updater.updateContactFields).not.toHaveBeenCalled();
  });

  it('swallows UnrecoverableError from the contact update and returns 200', async () => {
    const { controller, groupFetcher, updater } = makeController();
    groupFetcher.fetch.mockResolvedValue({
      apiKey: 'sk',
      aiFieldId: { id: 'cf', key: 'ai' },
    } satisfies GroupSettings);
    updater.updateContactFields.mockRejectedValue(new UnrecoverableError('400 bad'));

    const r = await controller.outbound(payload());

    expect(r).toEqual({ ok: true });
  });

  it('re-throws transient Error so GHL retries the webhook', async () => {
    const { controller, groupFetcher } = makeController();
    groupFetcher.fetch.mockRejectedValue(new Error('upstream 503'));

    await expect(controller.outbound(payload())).rejects.toThrow('upstream 503');
  });

  describe('insistence cancellation', () => {
    it('fetches the group before cancelling insistences on a human takeover', async () => {
      const { controller, groupFetcher, updater, insistenceClient } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        aiFieldId: { id: 'cf', key: 'ai' },
      } satisfies GroupSettings);
      updater.updateContactFields.mockResolvedValue({ status: 200, durationMs: 1 });

      await controller.outbound(payload());

      expect(insistenceClient.cancel).toHaveBeenCalledWith({
        jobId: 'm_1',
        contactId: 'c_1',
      });
      const cancelOrder = (insistenceClient.cancel as jest.Mock).mock.invocationCallOrder[0];
      const fetchOrder = (groupFetcher.fetch as jest.Mock).mock.invocationCallOrder[0];
      expect(fetchOrder).toBeLessThan(cancelOrder);
    });

    it('continues with the contact update when cancel rejects unexpectedly', async () => {
      const { controller, groupFetcher, updater, insistenceClient } = makeController();
      (insistenceClient.cancel as jest.Mock).mockRejectedValue(new Error('boom'));
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        aiFieldId: { id: 'cf', key: 'ai' },
      } satisfies GroupSettings);
      updater.updateContactFields.mockResolvedValue({ status: 200, durationMs: 1 });

      const r = await controller.outbound(payload());

      expect(r).toEqual({ ok: true, updated: true });
      expect(updater.updateContactFields).toHaveBeenCalled();
    });

    it('still cancels even when there is nothing to update', async () => {
      const { controller, groupFetcher, insistenceClient } = makeController();
      groupFetcher.fetch.mockResolvedValue({ apiKey: 'sk' } satisfies GroupSettings);

      const r = await controller.outbound(payload());

      expect(insistenceClient.cancel).toHaveBeenCalledWith({
        jobId: 'm_1',
        contactId: 'c_1',
      });
      expect(r).toEqual({ ok: true, skipped: 'nothing_to_update' });
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

  describe('non_blocking_users', () => {
    it('skips cancel + update when userId matches a non_blocking_users entry', async () => {
      const { controller, groupFetcher, updater, insistenceClient } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        aiFieldId: { id: 'cf', key: 'ai' },
        nonBlockingUsers: [
          { id: 'u_admin', name: 'Admin' },
          { id: 'u_1', name: 'Bot User' },
        ],
      } satisfies GroupSettings);

      const r = await controller.outbound(payload({ userId: 'u_1' }));

      expect(r).toEqual({ ok: true, skipped: 'non_blocking_user' });
      expect(insistenceClient.cancel).not.toHaveBeenCalled();
      expect(updater.updateContactFields).not.toHaveBeenCalled();
    });

    it('proceeds with cancel + update when userId is not in non_blocking_users', async () => {
      const { controller, groupFetcher, updater, insistenceClient } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        aiFieldId: { id: 'cf', key: 'ai' },
        nonBlockingUsers: [{ id: 'u_admin', name: 'Admin' }],
      } satisfies GroupSettings);
      updater.updateContactFields.mockResolvedValue({ status: 200, durationMs: 1 });

      const r = await controller.outbound(payload({ userId: 'u_human' }));

      expect(r).toEqual({ ok: true, updated: true });
      expect(insistenceClient.cancel).toHaveBeenCalled();
      expect(updater.updateContactFields).toHaveBeenCalled();
    });

    it('proceeds normally when nonBlockingUsers is undefined', async () => {
      const { controller, groupFetcher, updater, insistenceClient } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        aiFieldId: { id: 'cf', key: 'ai' },
      } satisfies GroupSettings);
      updater.updateContactFields.mockResolvedValue({ status: 200, durationMs: 1 });

      const r = await controller.outbound(payload());

      expect(r).toEqual({ ok: true, updated: true });
      expect(insistenceClient.cancel).toHaveBeenCalled();
      expect(updater.updateContactFields).toHaveBeenCalled();
    });
  });
});
