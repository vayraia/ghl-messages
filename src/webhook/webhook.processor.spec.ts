import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { WebhookProcessor } from './webhook.processor';
import { MessageDebouncer, DebouncedMessage, FlushJobData } from './message-debouncer';
import { WebhookForwarder } from './webhook-forwarder';
import { GhlContactClient } from './ghl-contact-client';
import { GhlReply } from './ghl-reply';
import { GroupFetcher } from './group-fetcher';
import { InsistenceClient } from './insistence-client';
import { WEBHOOK_FLUSH_JOB } from './webhook.tokens';
import { AppEnv } from '../config/env.validation';

function makeProcessor() {
  const debouncer = { drain: jest.fn() } as unknown as MessageDebouncer;
  const forwarder = { forward: jest.fn() } as unknown as WebhookForwarder;
  const ghl = { send: jest.fn() } as unknown as GhlReply;
  const groupFetcher = { fetch: jest.fn() } as unknown as GroupFetcher;
  const insistence = {
    schedule: jest.fn(),
    cancel: jest.fn(),
  } as unknown as InsistenceClient;
  const contactClient = {
    get: jest.fn().mockResolvedValue({ status: 200, customFields: [], firstName: undefined }),
    listCustomFields: jest.fn().mockResolvedValue(new Map<string, string>()),
    disableAiField: jest.fn(),
  } as unknown as GhlContactClient;
  const config = {
    get: (key: string) => (key === 'WEBHOOK_WORKER_CONCURRENCY' ? 5 : undefined),
  } as unknown as ConfigService<AppEnv, true>;

  const processor = new WebhookProcessor(
    config,
    debouncer,
    forwarder,
    ghl,
    groupFetcher,
    insistence,
    contactClient,
  );

  return { processor, debouncer, forwarder, ghl, groupFetcher, insistence, contactClient };
}

function makeJob(
  overrides: Partial<{ id: string; name: string; attemptsMade: number; data: FlushJobData }> = {},
) {
  return {
    id: overrides.id ?? 'job-1',
    name: overrides.name ?? WEBHOOK_FLUSH_JOB,
    attemptsMade: overrides.attemptsMade ?? 0,
    data:
      overrides.data ??
      ({
        debounceKey: 'ventas',
        contactId: 'c1',
        source: 'workflow',
        agentId: 'ventas',
      } as FlushJobData),
  } as unknown as Job<FlushJobData, unknown, string>;
}

const sampleItems: DebouncedMessage[] = [
  {
    body: 'hola',
    replyChannel: 'WhatsApp',
    contactName: 'Fabio',
    locationId: 'loc_abc',
    requestId: 'req-1',
    receivedAt: '2026-04-28T00:00:00.000Z',
  },
];

describe('WebhookProcessor.process', () => {
  it('fetches the group first, then forwards to chat, then ghl, then schedules insistence', async () => {
    const { processor, debouncer, forwarder, ghl, groupFetcher, insistence } = makeProcessor();

    (debouncer.drain as jest.Mock).mockResolvedValue(sampleItems);
    (groupFetcher.fetch as jest.Mock).mockResolvedValue({
      apiKey: 'pit-loc-key',
      insistences: [{ hours: 0, minutes: 10 }],
    });
    (forwarder.forward as jest.Mock).mockResolvedValue({
      messages: [{ type: 'text', content: 'reply' }],
      durationMs: 5,
    });
    (ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 3 });
    (insistence.schedule as jest.Mock).mockResolvedValue(undefined);

    const result = await processor.process(makeJob());

    expect(groupFetcher.fetch).toHaveBeenCalledWith('loc_abc', 'job-1');
    expect(forwarder.forward).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'ventas',
        contactId: 'c1',
        locationId: 'loc_abc',
        apiKey: 'pit-loc-key',
      }),
    );
    expect(ghl.send).toHaveBeenCalledWith({
      jobId: 'job-1',
      contactId: 'c1',
      message: 'reply',
      type: 'WhatsApp',
      apiKey: 'pit-loc-key',
    });
    expect(insistence.schedule).toHaveBeenCalledWith({
      jobId: 'job-1',
      locationId: 'loc_abc',
      contactId: 'c1',
      agentId: 'ventas',
      replyChannel: 'WhatsApp',
      apiKey: 'pit-loc-key',
      insistences: [{ hours: 0, minutes: 10 }],
      schedule: undefined,
    });

    const groupOrder = (groupFetcher.fetch as jest.Mock).mock.invocationCallOrder[0];
    const fwdOrder = (forwarder.forward as jest.Mock).mock.invocationCallOrder[0];
    const ghlOrder = (ghl.send as jest.Mock).mock.invocationCallOrder[0];
    const schedOrder = (insistence.schedule as jest.Mock).mock.invocationCallOrder[0];
    expect(groupOrder).toBeLessThan(fwdOrder);
    expect(fwdOrder).toBeLessThan(ghlOrder);
    expect(ghlOrder).toBeLessThan(schedOrder);

    expect(result).toMatchObject({ ok: true, drained: 1, ghlStatus: 200 });
  });

  it('forwards group.insistenceSchedule to the insistence client as schedule', async () => {
    const { processor, debouncer, forwarder, ghl, groupFetcher, insistence } = makeProcessor();

    const schedule = {
      monday: { active: true, start: '09:00', end: '18:00' },
      saturday: { active: false, start: '09:00', end: '13:00' },
    };
    (debouncer.drain as jest.Mock).mockResolvedValue(sampleItems);
    (groupFetcher.fetch as jest.Mock).mockResolvedValue({
      apiKey: 'pit-loc-key',
      insistences: [{ hours: 0, minutes: 10 }],
      insistenceSchedule: schedule,
    });
    (forwarder.forward as jest.Mock).mockResolvedValue({
      messages: [{ type: 'text', content: 'reply' }],
      durationMs: 5,
    });
    (ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 3 });
    (insistence.schedule as jest.Mock).mockResolvedValue(undefined);

    await processor.process(makeJob());

    expect(insistence.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ schedule }),
    );
  });

  it('throws UnrecoverableError when locationId is missing on the conversation', async () => {
    const { processor, debouncer, forwarder, ghl, groupFetcher } = makeProcessor();

    (debouncer.drain as jest.Mock).mockResolvedValue([{ ...sampleItems[0], locationId: undefined }]);

    await expect(processor.process(makeJob())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(groupFetcher.fetch).not.toHaveBeenCalled();
    expect(forwarder.forward).not.toHaveBeenCalled();
    expect(ghl.send).not.toHaveBeenCalled();
  });

  it('propagates GroupFetcher errors so BullMQ controls the retry policy', async () => {
    const { processor, debouncer, forwarder, ghl, groupFetcher } = makeProcessor();

    (debouncer.drain as jest.Mock).mockResolvedValue(sampleItems);
    (groupFetcher.fetch as jest.Mock).mockRejectedValue(new Error('Group fetch returned 503: down'));

    await expect(processor.process(makeJob())).rejects.toThrow(/503/);
    expect(forwarder.forward).not.toHaveBeenCalled();
    expect(ghl.send).not.toHaveBeenCalled();
  });

  it('still returns ok=true when the scheduler throws — failure is swallowed', async () => {
    const { processor, debouncer, forwarder, ghl, groupFetcher, insistence } = makeProcessor();

    (debouncer.drain as jest.Mock).mockResolvedValue(sampleItems);
    (groupFetcher.fetch as jest.Mock).mockResolvedValue({ apiKey: 'k', insistences: [] });
    (forwarder.forward as jest.Mock).mockResolvedValue({
      messages: [{ type: 'text', content: 'reply' }],
      durationMs: 5,
    });
    (ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 3 });
    (insistence.schedule as jest.Mock).mockRejectedValue(new Error('boom'));

    const result = await processor.process(makeJob());

    expect(result).toMatchObject({ ok: true, drained: 1, ghlStatus: 200 });
  });

  describe('AI gate', () => {
    function setupHappyPathMocks(p: ReturnType<typeof makeProcessor>) {
      (p.debouncer.drain as jest.Mock).mockResolvedValue(sampleItems);
      (p.forwarder.forward as jest.Mock).mockResolvedValue({
        messages: [{ type: 'text', content: 'reply' }],
        durationMs: 1,
      });
      (p.ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 1 });
      (p.insistence.schedule as jest.Mock).mockResolvedValue(undefined);
    }

    it('still fetches the contact when there is no aiFieldId (for firstName)', async () => {
      const p = makeProcessor();
      setupHappyPathMocks(p);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({ apiKey: 'k' });
      (p.contactClient.get as jest.Mock).mockResolvedValue({
        status: 200,
        customFields: [],
        firstName: 'Fabio',
      });

      await p.processor.process(makeJob());

      expect(p.contactClient.get).toHaveBeenCalledWith({
        jobId: 'job-1',
        contactId: 'c1',
        apiKey: 'k',
      });
      expect(p.forwarder.forward).toHaveBeenCalledWith(
        expect.objectContaining({ contactName: 'Fabio' }),
      );
      expect(p.ghl.send).toHaveBeenCalled();
    });

    it('forwards undefined contactName when the contact has no firstName', async () => {
      const p = makeProcessor();
      setupHappyPathMocks(p);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({ apiKey: 'k' });
      (p.contactClient.get as jest.Mock).mockResolvedValue({
        status: 200,
        customFields: [],
        firstName: undefined,
      });

      await p.processor.process(makeJob());

      expect(p.forwarder.forward).toHaveBeenCalledWith(
        expect.objectContaining({ contactName: undefined }),
      );
    });

    it('continues the flow when the ai_field is "Enabled"', async () => {
      const p = makeProcessor();
      setupHappyPathMocks(p);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({
        apiKey: 'k',
        aiFieldId: { id: 'cf_1', key: 'ai_status' },
      });
      (p.contactClient.get as jest.Mock).mockResolvedValue({
        status: 200,
        customFields: [{ id: 'cf_1', value: 'Enabled' }],
      });

      const result = await p.processor.process(makeJob());

      expect(p.contactClient.get).toHaveBeenCalledWith({
        jobId: 'job-1',
        contactId: 'c1',
        apiKey: 'k',
      });
      expect(p.forwarder.forward).toHaveBeenCalled();
      expect(p.ghl.send).toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, ghlStatus: 200 });
      expect(result).not.toHaveProperty('skipped');
    });

    it('continues when the ai_field is missing from the contact (treated as Enabled)', async () => {
      const p = makeProcessor();
      setupHappyPathMocks(p);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({
        apiKey: 'k',
        aiFieldId: { id: 'cf_1', key: 'ai_status' },
      });
      (p.contactClient.get as jest.Mock).mockResolvedValue({
        status: 200,
        customFields: [{ id: 'other_field', value: 'whatever' }],
      });

      await p.processor.process(makeJob());

      expect(p.forwarder.forward).toHaveBeenCalled();
      expect(p.ghl.send).toHaveBeenCalled();
    });

    it('continues when the ai_field has an unexpected value (treated as Enabled)', async () => {
      const p = makeProcessor();
      setupHappyPathMocks(p);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({
        apiKey: 'k',
        aiFieldId: { id: 'cf_1', key: 'ai_status' },
      });
      (p.contactClient.get as jest.Mock).mockResolvedValue({
        status: 200,
        customFields: [{ id: 'cf_1', value: 'Maybe' }],
      });

      await p.processor.process(makeJob());

      expect(p.forwarder.forward).toHaveBeenCalled();
      expect(p.ghl.send).toHaveBeenCalled();
    });

    it.each(['Disabled', 'disabled', 'DISABLED', '  Disabled  '])(
      'stops the flow when ai_field value is %j (case/whitespace insensitive)',
      async (raw) => {
        const p = makeProcessor();
        setupHappyPathMocks(p);
        (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({
          apiKey: 'k',
          aiFieldId: { id: 'cf_1', key: 'ai_status' },
        });
        (p.contactClient.get as jest.Mock).mockResolvedValue({
          status: 200,
          customFields: [{ id: 'cf_1', value: raw }],
        });

        const result = await p.processor.process(makeJob());

        expect(p.forwarder.forward).not.toHaveBeenCalled();
        expect(p.ghl.send).not.toHaveBeenCalled();
        expect(p.insistence.schedule).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: true, drained: 1, skipped: 'ai_disabled' });
      },
    );

    it('propagates UnrecoverableError from contact GET (4xx)', async () => {
      const p = makeProcessor();
      setupHappyPathMocks(p);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({
        apiKey: 'k',
        aiFieldId: { id: 'cf_1', key: 'ai_status' },
      });
      (p.contactClient.get as jest.Mock).mockRejectedValue(
        new UnrecoverableError('401 unauthorized'),
      );

      await expect(p.processor.process(makeJob())).rejects.toBeInstanceOf(UnrecoverableError);
      expect(p.forwarder.forward).not.toHaveBeenCalled();
    });

    it('propagates retryable Error from contact GET (5xx)', async () => {
      const p = makeProcessor();
      setupHappyPathMocks(p);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({
        apiKey: 'k',
        aiFieldId: { id: 'cf_1', key: 'ai_status' },
      });
      (p.contactClient.get as jest.Mock).mockRejectedValue(new Error('contact GET 503'));

      await expect(p.processor.process(makeJob())).rejects.toThrow(/503/);
      expect(p.forwarder.forward).not.toHaveBeenCalled();
    });
  });

  describe('custom field resolution', () => {
    function setupHappyPathMocks(p: ReturnType<typeof makeProcessor>) {
      (p.debouncer.drain as jest.Mock).mockResolvedValue(sampleItems);
      (p.forwarder.forward as jest.Mock).mockResolvedValue({
        messages: [{ type: 'text', content: 'reply' }],
        durationMs: 1,
      });
      (p.ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 1 });
      (p.insistence.schedule as jest.Mock).mockResolvedValue(undefined);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({ apiKey: 'k' });
    }

    it('resolves contact custom fields to { id, name, value } and forwards them', async () => {
      const p = makeProcessor();
      setupHappyPathMocks(p);
      (p.contactClient.get as jest.Mock).mockResolvedValue({
        status: 200,
        customFields: [
          { id: 'cf_1', value: 'Juan' },
          { id: 'cf_2', value: 'Premium' },
        ],
      });
      (p.contactClient.listCustomFields as jest.Mock).mockResolvedValue(
        new Map([
          ['cf_1', 'Nombre Cliente'],
          ['cf_2', 'Plan'],
        ]),
      );

      await p.processor.process(makeJob());

      expect(p.contactClient.listCustomFields).toHaveBeenCalledWith({
        jobId: 'job-1',
        locationId: 'loc_abc',
        apiKey: 'k',
      });
      expect(p.forwarder.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          customFields: [
            { id: 'cf_1', name: 'Nombre Cliente', value: 'Juan' },
            { id: 'cf_2', name: 'Plan', value: 'Premium' },
          ],
        }),
      );
    });

    it('skips the lookup and forwards undefined when the contact has no custom fields', async () => {
      const p = makeProcessor();
      setupHappyPathMocks(p);
      (p.contactClient.get as jest.Mock).mockResolvedValue({
        status: 200,
        customFields: [],
      });

      await p.processor.process(makeJob());

      expect(p.contactClient.listCustomFields).not.toHaveBeenCalled();
      expect(p.forwarder.forward).toHaveBeenCalledWith(
        expect.objectContaining({ customFields: undefined }),
      );
    });

    it('forwards undefined when no field id matches a definition', async () => {
      const p = makeProcessor();
      setupHappyPathMocks(p);
      (p.contactClient.get as jest.Mock).mockResolvedValue({
        status: 200,
        customFields: [{ id: 'cf_unknown', value: 'x' }],
      });
      (p.contactClient.listCustomFields as jest.Mock).mockResolvedValue(
        new Map([['cf_1', 'Nombre']]),
      );

      await p.processor.process(makeJob());

      expect(p.forwarder.forward).toHaveBeenCalledWith(
        expect.objectContaining({ customFields: undefined }),
      );
    });

    it('degrades gracefully and still forwards when the lookup throws', async () => {
      const p = makeProcessor();
      setupHappyPathMocks(p);
      (p.contactClient.get as jest.Mock).mockResolvedValue({
        status: 200,
        customFields: [{ id: 'cf_1', value: 'Juan' }],
      });
      (p.contactClient.listCustomFields as jest.Mock).mockRejectedValue(
        new Error('custom fields GET 503'),
      );

      const result = await p.processor.process(makeJob());

      expect(p.forwarder.forward).toHaveBeenCalledWith(
        expect.objectContaining({ customFields: undefined }),
      );
      expect(p.ghl.send).toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true });
    });
  });

  describe('inbound source', () => {
    function inboundJob(): Job<FlushJobData, unknown, string> {
      return makeJob({
        data: {
          debounceKey: 'loc:LOC123',
          contactId: 'c1',
          source: 'inbound',
          locationId: 'LOC123',
        },
      });
    }

    const inboundItems: DebouncedMessage[] = [
      {
        body: 'hola',
        replyChannel: 'WhatsApp',
        locationId: undefined,
        requestId: 'msg_1',
        receivedAt: '2026-05-06T19:50:39.476Z',
      },
    ];

    it('skips with no_default_agent when the group has no default_agent', async () => {
      const p = makeProcessor();
      (p.debouncer.drain as jest.Mock).mockResolvedValue(inboundItems);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({ apiKey: 'k' });

      const result = await p.processor.process(inboundJob());

      expect(p.groupFetcher.fetch).toHaveBeenCalledWith('LOC123', 'job-1');
      expect(p.forwarder.forward).not.toHaveBeenCalled();
      expect(p.ghl.send).not.toHaveBeenCalled();
      expect(p.insistence.schedule).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, drained: 1, skipped: 'no_default_agent' });
    });

    it('uses group.defaultAgent as agentId and runs the full flow', async () => {
      const p = makeProcessor();
      (p.debouncer.drain as jest.Mock).mockResolvedValue(inboundItems);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({
        apiKey: 'pit-k',
        defaultAgent: 'agent_default',
        insistences: [{ hours: 1 }],
      });
      (p.forwarder.forward as jest.Mock).mockResolvedValue({
        messages: [{ type: 'text', content: 'reply' }],
        durationMs: 1,
      });
      (p.ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 1 });
      (p.insistence.schedule as jest.Mock).mockResolvedValue(undefined);

      const result = await p.processor.process(inboundJob());

      expect(p.forwarder.forward).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent_default', contactId: 'c1', body: 'hola' }),
      );
      expect(p.ghl.send).toHaveBeenCalledWith({
        jobId: 'job-1',
        contactId: 'c1',
        message: 'reply',
        type: 'WhatsApp',
        apiKey: 'pit-k',
      });
      expect(p.insistence.schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          locationId: 'LOC123',
          contactId: 'c1',
          agentId: 'agent_default',
          replyChannel: 'WhatsApp',
          apiKey: 'pit-k',
        }),
      );
      expect(result).toMatchObject({ ok: true, drained: 1, ghlStatus: 200 });
    });

    it('prefers channel_agents over default_agent when the channel has an entry', async () => {
      const p = makeProcessor();
      (p.debouncer.drain as jest.Mock).mockResolvedValue(inboundItems);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({
        apiKey: 'pit-k',
        defaultAgent: 'agent_default',
        channelAgents: { whatsapp: 'agent_wpp' },
        insistences: [{ hours: 1 }],
      });
      (p.forwarder.forward as jest.Mock).mockResolvedValue({
        messages: [{ type: 'text', content: 'reply' }],
        durationMs: 1,
      });
      (p.ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 1 });
      (p.insistence.schedule as jest.Mock).mockResolvedValue(undefined);

      await p.processor.process(inboundJob());

      expect(p.forwarder.forward).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent_wpp' }),
      );
      expect(p.insistence.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent_wpp' }),
      );
    });

    it('falls back to default_agent when channel_agents has no entry for the channel', async () => {
      const p = makeProcessor();
      (p.debouncer.drain as jest.Mock).mockResolvedValue(inboundItems);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({
        apiKey: 'pit-k',
        defaultAgent: 'agent_default',
        channelAgents: { facebook: 'agent_fb' },
        insistences: [{ hours: 1 }],
      });
      (p.forwarder.forward as jest.Mock).mockResolvedValue({
        messages: [{ type: 'text', content: 'reply' }],
        durationMs: 1,
      });
      (p.ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 1 });
      (p.insistence.schedule as jest.Mock).mockResolvedValue(undefined);

      await p.processor.process(inboundJob());

      expect(p.forwarder.forward).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent_default' }),
      );
    });

    it('skips when neither channel_agents nor default_agent resolves an agent', async () => {
      const p = makeProcessor();
      (p.debouncer.drain as jest.Mock).mockResolvedValue(inboundItems);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({
        apiKey: 'pit-k',
        channelAgents: { facebook: 'agent_fb' },
      });

      const result = await p.processor.process(inboundJob());

      expect(p.forwarder.forward).not.toHaveBeenCalled();
      expect(p.ghl.send).not.toHaveBeenCalled();
      expect(p.insistence.schedule).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, drained: 1, skipped: 'no_default_agent' });
    });
  });

  it('does not invoke any downstream when the drained list is empty', async () => {
    const { processor, debouncer, groupFetcher, forwarder, ghl, insistence } = makeProcessor();
    (debouncer.drain as jest.Mock).mockResolvedValue([]);

    const result = await processor.process(makeJob());

    expect(groupFetcher.fetch).not.toHaveBeenCalled();
    expect(forwarder.forward).not.toHaveBeenCalled();
    expect(ghl.send).not.toHaveBeenCalled();
    expect(insistence.schedule).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, drained: 0 });
  });

  describe('multi-message fan-out', () => {
    // Resolve sleep() immediately while still capturing the delay value for
    // assertions — keeps these tests synchronous-fast without real waits.
    let setTimeoutSpy: jest.SpyInstance;

    beforeEach(() => {
      setTimeoutSpy = jest
        .spyOn(global, 'setTimeout')
        .mockImplementation(((cb: (..._args: unknown[]) => void) => {
          cb();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as unknown as typeof setTimeout);
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
    });

    function setupHappyDeps(p: ReturnType<typeof makeProcessor>) {
      (p.debouncer.drain as jest.Mock).mockResolvedValue(sampleItems);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({
        apiKey: 'pit-loc-key',
        insistences: [{ hours: 0, minutes: 10 }],
      });
      (p.insistence.schedule as jest.Mock).mockResolvedValue(undefined);
    }

    it('sends each chat message as a separate GHL call in order', async () => {
      const p = makeProcessor();
      setupHappyDeps(p);
      (p.forwarder.forward as jest.Mock).mockResolvedValue({
        messages: [
          { type: 'text', content: 'Encontré 3 opciones para vos.' },
          { type: 'image', url: 'https://cdn.app.com/img1.jpg', caption: 'Modelo A' },
          { type: 'text', content: 'Este tiene mejor batería.' },
          { type: 'file', url: 'https://cdn.app.com/specs.pdf', filename: 'specs.pdf' },
        ],
        durationMs: 5,
      });
      (p.ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 3 });

      await p.processor.process(makeJob());

      expect(p.ghl.send).toHaveBeenCalledTimes(4);
      const calls = (p.ghl.send as jest.Mock).mock.calls.map((c) => c[0]);
      expect(calls[0]).toMatchObject({
        message: 'Encontré 3 opciones para vos.',
        type: 'WhatsApp',
        attachments: undefined,
      });
      // image + WhatsApp routes through the structured whatsapp.media body,
      // not the flat attachments array.
      expect(calls[1]).toMatchObject({
        message: 'Modelo A',
        type: 'WhatsApp',
        whatsappMedia: {
          type: 'image',
          url: 'https://cdn.app.com/img1.jpg',
          caption: 'Modelo A',
          mimeType: 'image/jpeg',
        },
      });
      expect(calls[1]).not.toHaveProperty('attachments');
      expect(calls[2]).toMatchObject({
        message: 'Este tiene mejor batería.',
        attachments: undefined,
      });
      // file + WhatsApp routes through the structured whatsapp.media document
      // body, not the flat attachments array.
      expect(calls[3]).toMatchObject({
        message: '',
        type: 'WhatsApp',
        whatsappMedia: {
          type: 'document',
          name: 'specs.pdf',
          url: 'https://cdn.app.com/specs.pdf',
          caption: '',
          mimeType: 'application/pdf',
        },
      });
      expect(calls[3]).not.toHaveProperty('attachments');
    });

    it('waits 2500ms between consecutive sends (N-1 gaps for N messages)', async () => {
      const p = makeProcessor();
      setupHappyDeps(p);
      (p.forwarder.forward as jest.Mock).mockResolvedValue({
        messages: [
          { type: 'text', content: 'a' },
          { type: 'text', content: 'b' },
          { type: 'text', content: 'c' },
        ],
        durationMs: 5,
      });
      (p.ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 1 });

      await p.processor.process(makeJob());

      const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
      expect(delays).toEqual([2500, 2500]);
    });

    it('does not delay before the first send for a single-message reply', async () => {
      const p = makeProcessor();
      setupHappyDeps(p);
      (p.forwarder.forward as jest.Mock).mockResolvedValue({
        messages: [{ type: 'text', content: 'solo' }],
        durationMs: 5,
      });
      (p.ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 1 });

      await p.processor.process(makeJob());

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(p.ghl.send).toHaveBeenCalledTimes(1);
    });

    it('continues after a mid-sequence send failure and still schedules insistence', async () => {
      const p = makeProcessor();
      setupHappyDeps(p);
      (p.forwarder.forward as jest.Mock).mockResolvedValue({
        messages: [
          { type: 'text', content: 'one' },
          { type: 'text', content: 'two' },
          { type: 'text', content: 'three' },
        ],
        durationMs: 5,
      });
      (p.ghl.send as jest.Mock)
        .mockResolvedValueOnce({ status: 200, durationMs: 1 })
        .mockRejectedValueOnce(new Error('GHL returned 500'))
        .mockResolvedValueOnce({ status: 200, durationMs: 1 });

      const result = await p.processor.process(makeJob());

      expect(p.ghl.send).toHaveBeenCalledTimes(3);
      expect(p.insistence.schedule).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ok: true, drained: 1, ghlStatus: 200 });
    });

    it('skips insistence scheduling when every send fails', async () => {
      const p = makeProcessor();
      setupHappyDeps(p);
      (p.forwarder.forward as jest.Mock).mockResolvedValue({
        messages: [
          { type: 'text', content: 'one' },
          { type: 'text', content: 'two' },
        ],
        durationMs: 5,
      });
      (p.ghl.send as jest.Mock).mockRejectedValue(new Error('GHL returned 500'));

      const result = await p.processor.process(makeJob());

      expect(p.ghl.send).toHaveBeenCalledTimes(2);
      expect(p.insistence.schedule).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, drained: 1 });
      expect(result).not.toHaveProperty('ghlStatus', 200);
    });
  });

  describe('WhatsApp image media routing', () => {
    function setupImageReply(p: ReturnType<typeof makeProcessor>, group: Record<string, unknown>) {
      (p.debouncer.drain as jest.Mock).mockResolvedValue(sampleItems);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({ apiKey: 'pit-loc-key', ...group });
      (p.forwarder.forward as jest.Mock).mockResolvedValue({
        messages: [
          {
            type: 'image',
            url: 'https://assets.cdn.filesafe.space/loc/media/abc.jpg',
            caption: 'Prueba mensaje',
          },
        ],
        durationMs: 5,
      });
      (p.ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 3 });
      (p.insistence.schedule as jest.Mock).mockResolvedValue(undefined);
    }

    it('sends whatsapp.media with fromNumberId when the group has whatsappNumberId', async () => {
      const p = makeProcessor();
      setupImageReply(p, { whatsappNumberId: '1130377746823770' });

      await p.processor.process(makeJob());

      expect(p.ghl.send).toHaveBeenCalledWith({
        jobId: 'job-1',
        contactId: 'c1',
        message: 'Prueba mensaje',
        type: 'WhatsApp',
        apiKey: 'pit-loc-key',
        locationId: 'loc_abc',
        whatsappMedia: {
          type: 'image',
          url: 'https://assets.cdn.filesafe.space/loc/media/abc.jpg',
          caption: 'Prueba mensaje',
          mimeType: 'image/jpeg',
          fromNumberId: '1130377746823770',
        },
      });
    });

    it('sends whatsapp.media with fromNumberId=undefined when the group has no whatsappNumberId', async () => {
      const p = makeProcessor();
      setupImageReply(p, {});

      await p.processor.process(makeJob());

      const sent = (p.ghl.send as jest.Mock).mock.calls[0][0];
      expect(sent).toMatchObject({
        type: 'WhatsApp',
        whatsappMedia: { type: 'image', mimeType: 'image/jpeg' },
      });
      expect(sent.whatsappMedia.fromNumberId).toBeUndefined();
      expect(sent).not.toHaveProperty('attachments');
    });

    it('keeps the flat attachments shape for an image on a non-WhatsApp channel', async () => {
      const p = makeProcessor();
      (p.debouncer.drain as jest.Mock).mockResolvedValue([
        { ...sampleItems[0], replyChannel: 'IG' },
      ]);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({
        apiKey: 'pit-loc-key',
        whatsappNumberId: '1130377746823770',
      });
      (p.forwarder.forward as jest.Mock).mockResolvedValue({
        messages: [{ type: 'image', url: 'https://cdn.app.com/img.jpg', caption: 'cap' }],
        durationMs: 5,
      });
      (p.ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 3 });
      (p.insistence.schedule as jest.Mock).mockResolvedValue(undefined);

      await p.processor.process(makeJob());

      const sent = (p.ghl.send as jest.Mock).mock.calls[0][0];
      expect(sent).toMatchObject({
        type: 'IG',
        message: 'cap',
        attachments: ['https://cdn.app.com/img.jpg'],
      });
      expect(sent).not.toHaveProperty('whatsappMedia');
    });
  });

  describe('WhatsApp file (document) media routing', () => {
    function setupFileReply(
      p: ReturnType<typeof makeProcessor>,
      group: Record<string, unknown>,
      fileMessage: Record<string, unknown>,
    ) {
      (p.debouncer.drain as jest.Mock).mockResolvedValue(sampleItems);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({ apiKey: 'pit-loc-key', ...group });
      (p.forwarder.forward as jest.Mock).mockResolvedValue({
        messages: [fileMessage],
        durationMs: 5,
      });
      (p.ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 3 });
      (p.insistence.schedule as jest.Mock).mockResolvedValue(undefined);
    }

    it('sends whatsapp.media document with name, mimeType and fromNumberId', async () => {
      const p = makeProcessor();
      setupFileReply(
        p,
        { whatsappNumberId: '1130377746823770' },
        {
          type: 'file',
          url: 'https://cdn.ejemplo.com/docs/cotizacion-1234.pdf',
          filename: 'cotizacion-1234.pdf',
          caption: 'Cotización válida por 7 días',
        },
      );

      await p.processor.process(makeJob());

      expect(p.ghl.send).toHaveBeenCalledWith({
        jobId: 'job-1',
        contactId: 'c1',
        message: 'Cotización válida por 7 días',
        type: 'WhatsApp',
        apiKey: 'pit-loc-key',
        locationId: 'loc_abc',
        whatsappMedia: {
          type: 'document',
          name: 'cotizacion-1234.pdf',
          url: 'https://cdn.ejemplo.com/docs/cotizacion-1234.pdf',
          caption: 'Cotización válida por 7 días',
          mimeType: 'application/pdf',
          fromNumberId: '1130377746823770',
        },
      });
    });

    it('omits fromNumberId when the group has no whatsappNumberId', async () => {
      const p = makeProcessor();
      setupFileReply(
        p,
        {},
        { type: 'file', url: 'https://cdn.app.com/a.pdf', filename: 'a.pdf', caption: 'x' },
      );

      await p.processor.process(makeJob());

      const sent = (p.ghl.send as jest.Mock).mock.calls[0][0];
      expect(sent.whatsappMedia.fromNumberId).toBeUndefined();
      expect(sent).not.toHaveProperty('attachments');
    });

    it('derives media.name from the URL basename when filename is missing', async () => {
      const p = makeProcessor();
      setupFileReply(
        p,
        { whatsappNumberId: 'n1' },
        { type: 'file', url: 'https://cdn.app.com/media/6a29a45d.pdf', caption: '' },
      );

      await p.processor.process(makeJob());

      const sent = (p.ghl.send as jest.Mock).mock.calls[0][0];
      expect(sent.whatsappMedia.name).toBe('6a29a45d.pdf');
      expect(sent.whatsappMedia.mimeType).toBe('application/pdf');
    });

    it('keeps the flat shape for a file on a non-WhatsApp channel, using caption as message', async () => {
      const p = makeProcessor();
      (p.debouncer.drain as jest.Mock).mockResolvedValue([
        { ...sampleItems[0], replyChannel: 'IG' },
      ]);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({
        apiKey: 'pit-loc-key',
        whatsappNumberId: 'n1',
      });
      (p.forwarder.forward as jest.Mock).mockResolvedValue({
        messages: [
          { type: 'file', url: 'https://cdn.app.com/a.pdf', filename: 'a.pdf', caption: 'mirá esto' },
        ],
        durationMs: 5,
      });
      (p.ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 3 });
      (p.insistence.schedule as jest.Mock).mockResolvedValue(undefined);

      await p.processor.process(makeJob());

      const sent = (p.ghl.send as jest.Mock).mock.calls[0][0];
      expect(sent).toMatchObject({
        type: 'IG',
        message: 'mirá esto',
        attachments: ['https://cdn.app.com/a.pdf'],
      });
      expect(sent).not.toHaveProperty('whatsappMedia');
    });
  });
});
