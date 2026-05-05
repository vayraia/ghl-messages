import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { WebhookProcessor } from './webhook.processor';
import { MessageDebouncer, DebouncedMessage } from './message-debouncer';
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
    get: jest.fn(),
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

function makeJob(overrides: Partial<{ id: string; name: string; attemptsMade: number }> = {}) {
  return {
    id: overrides.id ?? 'job-1',
    name: overrides.name ?? WEBHOOK_FLUSH_JOB,
    attemptsMade: overrides.attemptsMade ?? 0,
    data: { agentId: 'ventas', contactId: 'c1' },
  } as unknown as Job<{ agentId: string; contactId: string }, unknown, string>;
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
    (forwarder.forward as jest.Mock).mockResolvedValue({ message: 'reply', durationMs: 5 });
    (ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 3 });
    (insistence.schedule as jest.Mock).mockResolvedValue(undefined);

    const result = await processor.process(makeJob());

    expect(groupFetcher.fetch).toHaveBeenCalledWith('loc_abc', 'job-1');
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
    (forwarder.forward as jest.Mock).mockResolvedValue({ message: 'reply', durationMs: 5 });
    (ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 3 });
    (insistence.schedule as jest.Mock).mockRejectedValue(new Error('boom'));

    const result = await processor.process(makeJob());

    expect(result).toMatchObject({ ok: true, drained: 1, ghlStatus: 200 });
  });

  describe('AI gate', () => {
    function setupHappyPathMocks(p: ReturnType<typeof makeProcessor>) {
      (p.debouncer.drain as jest.Mock).mockResolvedValue(sampleItems);
      (p.forwarder.forward as jest.Mock).mockResolvedValue({ message: 'reply', durationMs: 1 });
      (p.ghl.send as jest.Mock).mockResolvedValue({ status: 200, durationMs: 1 });
      (p.insistence.schedule as jest.Mock).mockResolvedValue(undefined);
    }

    it('skips the gate when the group has no aiFieldId configured', async () => {
      const p = makeProcessor();
      setupHappyPathMocks(p);
      (p.groupFetcher.fetch as jest.Mock).mockResolvedValue({ apiKey: 'k' });

      await p.processor.process(makeJob());

      expect(p.contactClient.get).not.toHaveBeenCalled();
      expect(p.forwarder.forward).toHaveBeenCalled();
      expect(p.ghl.send).toHaveBeenCalled();
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
});
