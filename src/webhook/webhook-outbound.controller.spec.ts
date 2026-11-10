import { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { OutboundWebhookPayloadDto } from './dto/outbound-webhook-payload.dto';
import { GhlContactClient } from './ghl-contact-client';
import { GroupFetcher, GroupSettings } from './group-fetcher';
import { AI_DISABLE_TAG } from './webhook.processor';
import { InsistenceClient } from './insistence-client';
import { ResponseTimeTracker } from './response-time.tracker';
import { WebhookOutboundController } from './webhook-outbound.controller';
import { AppEnv } from '../config/env.validation';

interface RedisMock {
  set: jest.Mock;
  del: jest.Mock;
}

function makeController() {
  const groupFetcher = { fetch: jest.fn() } as unknown as jest.Mocked<GroupFetcher>;
  const updater = {
    updateContactFields: jest.fn(),
    // Default: no field definitions resolved → no aiagent to clear. Individual
    // tests override this to exercise the agent-override clearing.
    listFieldDefs: jest.fn().mockResolvedValue({ idToName: new Map(), keyToId: new Map() }),
    get: jest.fn(),
    addTags: jest.fn(),
    removeTags: jest.fn(),
  } as unknown as jest.Mocked<GhlContactClient>;
  const insistenceClient = {
    schedule: jest.fn(),
    cancel: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<InsistenceClient>;
  const redis: RedisMock = {
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
  const responseTime = {
    recordAdvisorReply: jest.fn().mockResolvedValue('recorded'),
    wasSentByAi: jest.fn().mockResolvedValue(false),
  } as unknown as jest.Mocked<ResponseTimeTracker>;

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
    responseTime,
    config,
  );

  return { controller, groupFetcher, updater, insistenceClient, redis, responseTime };
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

// `handleStopMessage` does the actual group fetch + tag write; `outbound()`
// only acks immediately and fires it off in the background (see the
// "immediate ack" describe block below). stop_message tests call the
// private method directly so they can await and assert on its outcome
// deterministically, without racing the fire-and-forget wrapper.
interface TestableController {
  outbound(body: OutboundWebhookPayloadDto): { ok: true };
  handleStopMessage(body: OutboundWebhookPayloadDto): Promise<boolean | undefined>;
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
    // The legacy disable/cancel flow stays off. (The group IS fetched now, in the
    // background, to read the human-takeover flag — covered in its own describe.)
    expect(insistenceClient.cancel).not.toHaveBeenCalled();
    void groupFetcher;
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

  // The tests below (idempotency, AI disable, aiagent clear, insistence cancel,
  // non_blocking_users) cover the human-takeover body of `outbound()`, which is
  // temporarily disabled behind an early `return { ok: true }` (see the comment
  // in webhook-outbound.controller.ts). Skipped, not deleted: un-skip them when
  // that block is re-enabled.
  it.skip('deduplicates on messageId via Redis SET NX EX', async () => {
    const { controller, groupFetcher, insistenceClient, redis } = makeController();
    redis.set.mockResolvedValueOnce(null);

    const r = await controller.outbound(payload());

    expect(r).toEqual({ ok: true, deduplicated: true });
    expect(redis.set).toHaveBeenCalledWith('webhook:outbound:idem:m_1', '1', 'EX', 3600, 'NX');
    expect(groupFetcher.fetch).not.toHaveBeenCalled();
    expect(insistenceClient.cancel).not.toHaveBeenCalled();
  });

  it.skip('skips idempotency check when messageId is missing', async () => {
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

  it.skip('returns skipped=nothing_to_update when no aiFieldId and no aiagent field', async () => {
    const { controller, groupFetcher, updater } = makeController();
    groupFetcher.fetch.mockResolvedValue({ apiKey: 'sk' } satisfies GroupSettings);

    const r = await controller.outbound(payload());

    expect(r).toEqual({ ok: true, skipped: 'nothing_to_update' });
    expect(updater.updateContactFields).not.toHaveBeenCalled();
  });

  it.skip('disables the AI field with the group apiKey when ai_field_id is configured', async () => {
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

  describe.skip('aiagent override clearing', () => {
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

  it.skip('re-throws transient Error so GHL retries the webhook', async () => {
    const { controller, groupFetcher } = makeController();
    groupFetcher.fetch.mockRejectedValue(new Error('upstream 503'));

    await expect(controller.outbound(payload())).rejects.toThrow('upstream 503');
  });

  describe.skip('insistence cancellation', () => {
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

  describe.skip('non_blocking_users', () => {
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

  describe('immediate ack', () => {
    it('outbound() acks { ok: true } synchronously, before any processing runs', () => {
      const { controller, groupFetcher } = makeController();
      // fetch() never resolves in this test — if outbound() awaited it, this
      // test would hang. It doesn't, so the ack still returns.
      groupFetcher.fetch.mockReturnValue(new Promise(() => {}));
      const r = (controller as unknown as TestableController).outbound(
        payload({ body: 'STOP BOT' }),
      );
      expect(r).toEqual({ ok: true });
    });

    it('still acks { ok: true } when the background processing throws (retryable error)', () => {
      const { controller, groupFetcher } = makeController();
      groupFetcher.fetch.mockRejectedValue(new Error('upstream 503'));
      const testable = controller as unknown as TestableController;
      expect(() => testable.outbound(payload({ body: 'STOP BOT' }))).not.toThrow();
      expect(testable.outbound(payload({ body: 'STOP BOT' }))).toEqual({ ok: true });
    });
  });

  describe('stop_message tag (handleStopMessage)', () => {
    // The disabled legacy block requires userId; the new stop_message check
    // does not, so these tests explicitly omit it where relevant.
    function deliveredPayload(
      over: Partial<OutboundWebhookPayloadDto> = {},
    ): OutboundWebhookPayloadDto {
      return payload({ userId: undefined, body: 'STOP BOT', status: 'sent', ...over });
    }

    function testable(controller: unknown): TestableController {
      return controller as unknown as TestableController;
    }

    it('tags the contact when body matches stop_message exactly', async () => {
      const { controller, groupFetcher, updater } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk_xxx',
        stopMessage: 'STOP BOT',
      } satisfies GroupSettings);
      updater.addTags.mockResolvedValue({ status: 200, durationMs: 5 });

      const tagged = await testable(controller).handleStopMessage(deliveredPayload());

      expect(groupFetcher.fetch).toHaveBeenCalledWith('loc_1', 'm_1');
      expect(updater.addTags).toHaveBeenCalledWith({
        jobId: 'm_1',
        contactId: 'c_1',
        apiKey: 'sk_xxx',
        tags: ['desactivar ia'],
      });
      expect(tagged).toBe(true);
    });

    it('removes the tag when body matches start_message', async () => {
      const { controller, groupFetcher, updater } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk_xxx',
        stopMessage: 'STOP BOT',
        startMessage: 'START BOT',
      } satisfies GroupSettings);
      updater.removeTags.mockResolvedValue({ status: 200, durationMs: 5 });

      const result = await testable(controller).handleStopMessage(
        deliveredPayload({ body: ' start bot ' }),
      );

      expect(updater.removeTags).toHaveBeenCalledWith({
        jobId: 'm_1',
        contactId: 'c_1',
        apiKey: 'sk_xxx',
        tags: ['desactivar ia'],
      });
      expect(updater.addTags).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('matches case-insensitively and ignoring surrounding whitespace', async () => {
      const { controller, groupFetcher, updater } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        stopMessage: 'Stop Bot',
      } satisfies GroupSettings);
      updater.addTags.mockResolvedValue({ status: 200, durationMs: 1 });

      const tagged = await testable(controller).handleStopMessage(
        deliveredPayload({ body: '  stop bot  ' }),
      );

      expect(updater.addTags).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['desactivar ia'] }),
      );
      expect(tagged).toBe(true);
    });

    it('applies to a bot-sent message too (no userId required)', async () => {
      const { controller, groupFetcher, updater } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        stopMessage: 'STOP BOT',
      } satisfies GroupSettings);
      updater.addTags.mockResolvedValue({ status: 200, durationMs: 1 });

      const tagged = await testable(controller).handleStopMessage(
        deliveredPayload({ userId: undefined }),
      );

      expect(updater.addTags).toHaveBeenCalled();
      expect(tagged).toBe(true);
    });

    it('does not tag when body does not match stop_message', async () => {
      const { controller, groupFetcher, updater } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        stopMessage: 'STOP BOT',
      } satisfies GroupSettings);

      const tagged = await testable(controller).handleStopMessage(
        deliveredPayload({ body: 'This is a test message' }),
      );

      expect(updater.addTags).not.toHaveBeenCalled();
      expect(tagged).toBe(false);
    });

    it('does not tag when the group has no stop_message configured', async () => {
      const { controller, groupFetcher, updater } = makeController();
      groupFetcher.fetch.mockResolvedValue({ apiKey: 'sk' } satisfies GroupSettings);

      const tagged = await testable(controller).handleStopMessage(deliveredPayload());

      expect(updater.addTags).not.toHaveBeenCalled();
      expect(tagged).toBeUndefined();
    });

    it('does not fetch the group or tag when body is missing', async () => {
      const { controller, groupFetcher, updater } = makeController();

      const tagged = await testable(controller).handleStopMessage(
        deliveredPayload({ body: undefined }),
      );

      expect(groupFetcher.fetch).not.toHaveBeenCalled();
      expect(updater.addTags).not.toHaveBeenCalled();
      expect(tagged).toBeUndefined();
    });

    it('does not fetch the group or tag when type is not OutboundMessage', async () => {
      const { controller, groupFetcher, updater } = makeController();

      const tagged = await testable(controller).handleStopMessage(
        deliveredPayload({ type: 'InboundMessage' }),
      );

      expect(groupFetcher.fetch).not.toHaveBeenCalled();
      expect(updater.addTags).not.toHaveBeenCalled();
      expect(tagged).toBeUndefined();
    });

    it('tags on status "delivered" too (Facebook/Instagram/TikTok never emit "sent")', async () => {
      const { controller, groupFetcher, updater } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        stopMessage: 'STOP BOT',
      } satisfies GroupSettings);

      const tagged = await testable(controller).handleStopMessage(
        deliveredPayload({ status: 'delivered' }),
      );

      expect(updater.addTags).toHaveBeenCalledTimes(1);
      expect(tagged).toBe(true);
    });

    it('does not fetch the group or tag when status is neither sent nor delivered', async () => {
      const { controller, groupFetcher, updater } = makeController();

      const tagged = await testable(controller).handleStopMessage(
        deliveredPayload({ status: 'failed' }),
      );

      expect(groupFetcher.fetch).not.toHaveBeenCalled();
      expect(updater.addTags).not.toHaveBeenCalled();
      expect(tagged).toBeUndefined();
    });

    it('swallows UnrecoverableError from the group fetch and returns false', async () => {
      const { controller, groupFetcher, updater } = makeController();
      groupFetcher.fetch.mockRejectedValue(new UnrecoverableError('bad config'));

      const tagged = await testable(controller).handleStopMessage(deliveredPayload());

      expect(updater.addTags).not.toHaveBeenCalled();
      expect(tagged).toBe(false);
    });

    it('re-throws a retryable Error from the group fetch (caught by the background .catch in outbound())', async () => {
      const { controller, groupFetcher } = makeController();
      groupFetcher.fetch.mockRejectedValue(new Error('upstream 503'));

      await expect(testable(controller).handleStopMessage(deliveredPayload())).rejects.toThrow(
        'upstream 503',
      );
    });

    it('swallows UnrecoverableError from addTags and returns false', async () => {
      const { controller, groupFetcher, updater } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        stopMessage: 'STOP BOT',
      } satisfies GroupSettings);
      updater.addTags.mockRejectedValue(new UnrecoverableError('400 bad'));

      const tagged = await testable(controller).handleStopMessage(deliveredPayload());

      expect(tagged).toBe(false);
    });

    it('re-throws a retryable Error from addTags (caught by the background .catch in outbound())', async () => {
      const { controller, groupFetcher, updater } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        stopMessage: 'STOP BOT',
      } satisfies GroupSettings);
      updater.addTags.mockRejectedValue(new Error('upstream 503'));

      await expect(testable(controller).handleStopMessage(deliveredPayload())).rejects.toThrow(
        'upstream 503',
      );
    });

    it('uses messageId as jobId when present, otherwise contactId:locationId', async () => {
      const { controller, groupFetcher, updater } = makeController();
      groupFetcher.fetch.mockResolvedValue({
        apiKey: 'sk',
        stopMessage: 'STOP BOT',
      } satisfies GroupSettings);
      updater.addTags.mockResolvedValue({ status: 200, durationMs: 1 });

      await testable(controller).handleStopMessage(deliveredPayload({ messageId: undefined }));

      expect(groupFetcher.fetch).toHaveBeenCalledWith('loc_1', 'c_1:loc_1');
      expect(updater.addTags).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'c_1:loc_1' }));
    });
  });
});

describe('WebhookOutboundController advisor response-time tracking', () => {
  type Tracking = { trackAdvisorReply(body: OutboundWebhookPayloadDto): Promise<void> };

  it('records a sent OutboundMessage that carries a userId', async () => {
    const { controller, responseTime } = makeController();
    await (controller as unknown as Tracking).trackAdvisorReply(
      payload({ status: 'sent', dateAdded: '2026-01-01T00:00:10.000Z' }),
    );
    expect(responseTime.recordAdvisorReply).toHaveBeenCalledWith({
      locationId: 'loc_1',
      contactId: 'c_1',
      userId: 'u_1',
      messageId: 'm_1',
      repliedAt: Date.parse('2026-01-01T00:00:10.000Z'),
    });
  });

  it.each([
    ['wrong type', { type: 'InboundMessage' }],
    ['other status', { status: 'read' }],
    ['no userId', { userId: undefined }],
    ['no messageId', { messageId: undefined }],
    ['no contactId', { contactId: undefined }],
  ])('ignores the payload when %s', async (_name, over) => {
    const { controller, responseTime } = makeController();
    await (controller as unknown as Tracking).trackAdvisorReply(
      payload(over as Partial<OutboundWebhookPayloadDto>),
    );
    expect(responseTime.recordAdvisorReply).not.toHaveBeenCalled();
  });
});

describe('WebhookOutboundController human takeover (disable_ai_on_human_message)', () => {
  type Takeover = {
    handleHumanTakeover(body: OutboundWebhookPayloadDto): Promise<boolean | undefined>;
  };

  function setup(group: Partial<GroupSettings> = {}) {
    const ctx = makeController();
    ctx.groupFetcher.fetch.mockResolvedValue({
      apiKey: 'k',
      disableAiOnHumanMessage: true,
      ...group,
    } as GroupSettings);
    const run = (over: Partial<OutboundWebhookPayloadDto> = {}) =>
      (ctx.controller as unknown as Takeover).handleHumanTakeover(payload(over));
    return { ...ctx, run };
  }

  it('tags the contact when a human agent writes and the flag is on', async () => {
    const { run, updater } = setup();
    await expect(run()).resolves.toBe(true);
    expect(updater.addTags).toHaveBeenCalledWith({
      jobId: 'm_1',
      contactId: 'c_1',
      apiKey: 'k',
      tags: [AI_DISABLE_TAG],
    });
  });

  it('does nothing when the flag is off or absent (default)', async () => {
    const { run, updater } = setup({ disableAiOnHumanMessage: undefined });
    await expect(run()).resolves.toBeUndefined();
    expect(updater.addTags).not.toHaveBeenCalled();
  });

  it('never tags a message without userId (sent through the API)', async () => {
    const { run, updater, groupFetcher } = setup();
    await expect(run({ userId: undefined })).resolves.toBeUndefined();
    expect(updater.addTags).not.toHaveBeenCalled();
    expect(groupFetcher.fetch).not.toHaveBeenCalled();
  });

  it('never tags a message the AI sent (same userId as the assigned agent)', async () => {
    const { run, updater, responseTime } = setup();
    responseTime.wasSentByAi.mockResolvedValue(true);
    await expect(run()).resolves.toBe(false);
    expect(updater.addTags).not.toHaveBeenCalled();
  });

  it('ignores users listed in non_blocking_users', async () => {
    const { run, updater } = setup({ nonBlockingUsers: [{ id: 'u_1' }] as never });
    await expect(run()).resolves.toBe(false);
    expect(updater.addTags).not.toHaveBeenCalled();
  });

  it('leaves stop/start phrases to the stop_message logic (no re-tag on start_message)', async () => {
    const { run, updater } = setup({ stopMessage: 'Stop', startMessage: 'Start' });
    await expect(run({ body: ' start ' })).resolves.toBe(false);
    await expect(run({ body: 'STOP' })).resolves.toBe(false);
    expect(updater.addTags).not.toHaveBeenCalled();
  });

  it('handles a message once even if GHL sends both sent and delivered', async () => {
    const { run, updater, redis } = setup();
    await run({ status: 'sent' });
    redis.set.mockResolvedValue(null);
    await expect(run({ status: 'delivered' })).resolves.toBeUndefined();
    expect(updater.addTags).toHaveBeenCalledTimes(1);
  });

  it('ignores other statuses and types', async () => {
    const { run, updater } = setup();
    await expect(run({ status: 'read' })).resolves.toBeUndefined();
    await expect(run({ type: 'InboundMessage' })).resolves.toBeUndefined();
    expect(updater.addTags).not.toHaveBeenCalled();
  });

  it('releases the dedup key and rethrows on a retryable tag failure', async () => {
    const { run, updater, redis } = setup();
    updater.addTags.mockRejectedValue(new Error('boom'));
    await expect(run()).rejects.toThrow('boom');
    expect(redis.del).toHaveBeenCalledWith('webhook:outbound:takeover:m_1');
  });

  it('swallows a permanent tag failure', async () => {
    const { run, updater } = setup();
    updater.addTags.mockRejectedValue(new UnrecoverableError('bad'));
    await expect(run()).resolves.toBe(false);
  });
});
