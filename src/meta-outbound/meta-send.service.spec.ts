import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { AppEnv } from '../config/env.validation';
import { SendWhatsAppDto } from './dto/send-whatsapp.dto';
import { MetaChannelRepository } from './meta-channel.repository';
import { META_SEND_JOB } from './meta-outbound.constants';
import { MetaSendService } from './meta-send.service';

function makeSut() {
  const add = jest.fn().mockResolvedValue({ id: 'x' });
  const set = jest.fn().mockResolvedValue('OK');
  const findPhoneNumberIdByLocationId = jest.fn();
  const queue = { add } as unknown as Queue;
  const redis = { set } as unknown as Redis;
  const channels = { findPhoneNumberIdByLocationId } as unknown as MetaChannelRepository;
  const env: Record<string, number> = {
    IDEMPOTENCY_TTL_SECONDS: 3600,
    META_OUTBOUND_JOB_ATTEMPTS: 5,
    META_OUTBOUND_BACKOFF_MS: 2000,
  };
  const config = { get: (k: string) => env[k] } as unknown as ConfigService<AppEnv, true>;
  return {
    sut: new MetaSendService(queue, redis, channels, config),
    add,
    set,
    findPhoneNumberIdByLocationId,
  };
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

  it('resolves the phone_number_id from locationId (1:1) and enqueues with it', async () => {
    const { sut, add, findPhoneNumberIdByLocationId } = makeSut();
    findPhoneNumberIdByLocationId.mockResolvedValue('999');

    const result = await sut.enqueue(
      dto({ type: 'text', body: 'hi' }, { phoneNumberId: undefined, locationId: 'loc-1' }),
    );

    expect(findPhoneNumberIdByLocationId).toHaveBeenCalledWith('loc-1');
    expect(result.jobId).toMatch(/^wa_999_/);
    expect(add.mock.calls[0][1]).toMatchObject({ phoneNumberId: '999' });
  });

  it('throws NotFound when the locationId has no registered channel', async () => {
    const { sut, add, findPhoneNumberIdByLocationId } = makeSut();
    findPhoneNumberIdByLocationId.mockResolvedValue(null);

    await expect(
      sut.enqueue(
        dto({ type: 'text', body: 'hi' }, { phoneNumberId: undefined, locationId: 'nope' }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(add).not.toHaveBeenCalled();
  });

  it('throws 400 when neither phoneNumberId nor locationId is provided', async () => {
    const { sut, add } = makeSut();
    await expect(
      sut.enqueue(dto({ type: 'text', body: 'hi' }, { phoneNumberId: undefined })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(add).not.toHaveBeenCalled();
  });

  it('prefers phoneNumberId over locationId when both are present', async () => {
    const { sut, add, findPhoneNumberIdByLocationId } = makeSut();

    await sut.enqueue(dto({ type: 'text', body: 'hi' }, { locationId: 'loc-1' }));

    expect(findPhoneNumberIdByLocationId).not.toHaveBeenCalled();
    expect(add.mock.calls[0][1]).toMatchObject({ phoneNumberId: '123' });
  });
});
