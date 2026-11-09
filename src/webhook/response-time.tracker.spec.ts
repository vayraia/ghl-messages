import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../config/env.validation';
import { ResponseTimeTracker } from './response-time.tracker';

function makeTracker(graceMs = 0, enabled = true) {
  const exec = jest.fn();
  const multi = { get: jest.fn().mockReturnThis(), del: jest.fn().mockReturnThis(), exec };
  const redis = {
    set: jest.fn().mockResolvedValue('OK'),
    exists: jest.fn().mockResolvedValue(0),
    multi: jest.fn().mockReturnValue(multi),
  };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const env: Record<string, number> = {
    RESPONSE_TIME_PENDING_TTL_SECONDS: 600,
    RESPONSE_TIME_ENABLED: enabled as unknown as number,
    RESPONSE_TIME_AI_GRACE_MS: graceMs,
  };
  const config = { get: (k: string) => env[k] } as unknown as ConfigService<AppEnv, true>;
  const tracker = new ResponseTimeTracker(redis as never, queue as never, config);
  return { tracker, redis, queue, exec };
}

const reply = {
  locationId: 'loc_1',
  contactId: 'c_1',
  userId: 'u_1',
  messageId: 'm_out',
  repliedAt: 2_000,
};

describe('ResponseTimeTracker', () => {
  it('markAiSent stores the messageId with a TTL and ignores undefined', async () => {
    const { tracker, redis } = makeTracker();
    await tracker.markAiSent('m_ai');
    await tracker.markAiSent(undefined);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith('webhook:ai-sent:m_ai', '1', 'EX', 3600);
  });

  it('registerInbound keeps the OLDEST unanswered message (SET NX) with the pending TTL', async () => {
    const { tracker, redis } = makeTracker();
    await tracker.registerInbound({
      locationId: 'loc_1',
      contactId: 'c_1',
      messageId: 'm_in',
      channel: 'WhatsApp',
      inboundAt: 1_000,
    });
    expect(redis.set).toHaveBeenCalledWith(
      'webhook:rt:pending:loc_1:c_1',
      JSON.stringify({ inboundAt: 1_000, messageId: 'm_in', channel: 'WhatsApp' }),
      'EX',
      600,
      'NX',
    );
  });

  it('does not count a message the AI sent, and does not touch the pending clock', async () => {
    const { tracker, redis, queue } = makeTracker();
    redis.exists.mockResolvedValue(1);
    await expect(tracker.recordAdvisorReply(reply)).resolves.toBe('ai_message');
    expect(redis.multi).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('re-checks the AI mark after the grace window (outbound can beat the send response)', async () => {
    const { tracker, redis, queue } = makeTracker(5);
    redis.exists.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    await expect(tracker.recordAdvisorReply(reply)).resolves.toBe('ai_message');
    expect(redis.exists).toHaveBeenCalledTimes(2);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('returns no_pending when there is no unanswered inbound', async () => {
    const { tracker, exec, queue } = makeTracker();
    exec.mockResolvedValue([
      [null, null],
      [null, 0],
    ]);
    await expect(tracker.recordAdvisorReply(reply)).resolves.toBe('no_pending');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('closes the clock for an advisor reply: takes the pending inbound and enqueues the persist job', async () => {
    const { tracker, exec, queue } = makeTracker();
    exec.mockResolvedValue([
      [null, JSON.stringify({ inboundAt: 1_000, messageId: 'm_in', channel: 'WhatsApp' })],
      [null, 1],
    ]);
    await expect(tracker.recordAdvisorReply(reply)).resolves.toBe('recorded');
    expect(queue.add).toHaveBeenCalledWith(
      'persist-response-time',
      {
        locationId: 'loc_1',
        contactId: 'c_1',
        userId: 'u_1',
        channel: 'WhatsApp',
        inboundMessageId: 'm_in',
        outboundMessageId: 'm_out',
        inboundAt: 1_000,
        repliedAt: 2_000,
      },
      expect.objectContaining({ jobId: 'rt_m_out', attempts: 5 }),
    );
  });

  it('is a complete no-op when RESPONSE_TIME_ENABLED is off (no Redis, no queue)', async () => {
    const { tracker, redis, queue } = makeTracker(0, false);
    await tracker.markAiSent('m_ai');
    await tracker.registerInbound({ locationId: 'l', contactId: 'c', inboundAt: 1 });
    await expect(tracker.recordAdvisorReply(reply)).resolves.toBe('no_pending');
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.exists).not.toHaveBeenCalled();
    expect(redis.multi).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
