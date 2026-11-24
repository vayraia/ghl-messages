import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../config/env.validation';
import { AiBillingNotifier } from './ai-billing-notifier';

function make(apiKey: string | undefined) {
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const config = {
    get: (k: string) => (k === 'AI_SERVICE_API_KEY' ? apiKey : undefined),
  } as unknown as ConfigService<AppEnv, true>;
  return { notifier: new AiBillingNotifier(queue as never, config), queue };
}

const input = { locationId: 'loc_1', contactId: 'c_1', jobId: 'flush_loc_1_c_1_17:99-abc' };

describe('AiBillingNotifier', () => {
  it('is off without AI_SERVICE_API_KEY (unset or blank): nothing is enqueued', async () => {
    for (const key of [undefined, '', '   ']) {
      const { notifier, queue } = make(key);
      await notifier.notifyReply(input);
      expect(queue.add).not.toHaveBeenCalled();
    }
  });

  it('enqueues the event with a BullMQ-safe job id, retries and a timestamp', async () => {
    const { notifier, queue } = make('svc-key');
    await notifier.notifyReply(input);
    expect(queue.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe('register-ai-contact');
    expect(data).toEqual({ ...input, occurredAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(data.occurredAt))).toBe(false);
    expect(opts.jobId).toBe('abe_flush_loc_1_c_1_17_99-abc_c_1');
    expect(opts.jobId).not.toContain(':');
    expect(opts.attempts).toBe(5);
  });

  it('never throws when the queue is down', async () => {
    const { notifier, queue } = make('svc-key');
    queue.add.mockRejectedValue(new Error('redis down'));
    await expect(notifier.notifyReply(input)).resolves.toBeUndefined();
  });
});
