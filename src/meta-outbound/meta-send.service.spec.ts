import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { AppEnv } from '../config/env.validation';
import { SendWhatsAppDto } from './dto/send-whatsapp.dto';
import { META_SEND_JOB } from './meta-outbound.constants';
import { MetaSendService } from './meta-send.service';

function makeSut() {
  const add = jest.fn().mockResolvedValue({ id: 'x' });
  const set = jest.fn().mockResolvedValue('OK');
  const queue = { add } as unknown as Queue;
  const redis = { set } as unknown as Redis;
  const env: Record<string, number> = {
    IDEMPOTENCY_TTL_SECONDS: 3600,
    META_OUTBOUND_JOB_ATTEMPTS: 5,
    META_OUTBOUND_BACKOFF_MS: 2000,
  };
  const config = { get: (k: string) => env[k] } as unknown as ConfigService<AppEnv, true>;
  return { sut: new MetaSendService(queue, redis, config), add, set };
}

function dto(
  message: Record<string, unknown>,
  overrides: Partial<SendWhatsAppDto> = {},
): SendWhatsAppDto {
  return { phoneNumberId: '123', to: '5493510000000', message, ...overrides };
}

describe('MetaSendService', () => {
  it('rejects an invalid message with 400 and never enqueues', async () => {
    const { sut, add } = makeSut();
    await expect(sut.enqueue(dto({ type: 'text', body: '' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(add).not.toHaveBeenCalled();
  });

  it('enqueues a valid message with the built body and retry policy', async () => {
    const { sut, add } = makeSut();
    const result = await sut.enqueue(dto({ type: 'text', body: 'hola' }));

    expect(result.deduplicated).toBe(false);
    expect(result.jobId).toMatch(/^wa_123_/);
    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0];
    expect(name).toBe(META_SEND_JOB);
    expect(data).toEqual({
      phoneNumberId: '123',
      body: expect.objectContaining({
        messaging_product: 'whatsapp',
        to: '5493510000000',
        type: 'text',
      }),
    });
    expect(opts).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });
  });

  it('uses the idempotency key as a (sanitized) job id when fresh', async () => {
    const { sut, add, set } = makeSut();
    const result = await sut.enqueue(dto({ type: 'text', body: 'hi' }), {
      idempotencyKey: 'evt:42',
    });

    expect(set).toHaveBeenCalledWith('meta:outbound:idem:evt:42', '1', 'EX', 3600, 'NX');
    expect(result.jobId).toBe('wa_evt_42'); // ':' sanitized for BullMQ
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('deduplicates when the idempotency key was already seen', async () => {
    const { sut, add, set } = makeSut();
    set.mockResolvedValueOnce(null); // SET NX returns null → key already present

    const result = await sut.enqueue(dto({ type: 'text', body: 'hi' }), {
      idempotencyKey: 'evt-1',
    });

    expect(result).toEqual({ jobId: 'evt-1', deduplicated: true });
    expect(add).not.toHaveBeenCalled();
  });
});
