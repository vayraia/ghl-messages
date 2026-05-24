import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { MetaChannelCredentials, MetaChannelRepository } from './meta-channel.repository';
import { META_SEND_JOB } from './meta-outbound.constants';
import { MetaSendProcessor } from './meta-send.processor';
import { MetaSendJobData } from './meta-send.service';
import { WhatsAppCloudClient } from './whatsapp-cloud-client';

function makeSut() {
  const findByPhoneNumberId = jest.fn();
  const send = jest.fn();
  const channels = { findByPhoneNumberId } as unknown as MetaChannelRepository;
  const client = { send } as unknown as WhatsAppCloudClient;
  const config = { get: () => 10 } as unknown as ConfigService<AppEnv, true>;
  return { sut: new MetaSendProcessor(config, channels, client), findByPhoneNumberId, send };
}

const jobData: MetaSendJobData = {
  phoneNumberId: '123',
  body: {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '549',
    type: 'text',
    text: { body: 'hi' },
  },
};

function makeJob(
  overrides: Partial<Job<MetaSendJobData>> = {},
): Job<MetaSendJobData, unknown, string> {
  return {
    id: 'j-1',
    name: META_SEND_JOB,
    data: jobData,
    attemptsMade: 0,
    ...overrides,
  } as unknown as Job<MetaSendJobData, unknown, string>;
}

const activeCreds: MetaChannelCredentials = {
  id: 'id-1',
  tenantKey: 'wa:123',
  channel: 'whatsapp',
  phoneNumberId: '123',
  wabaId: null,
  displayPhoneNumber: null,
  accessToken: 'TOKEN',
  graphApiVersion: 'v20.0',
  locationId: null,
  status: 'active',
};

describe('MetaSendProcessor', () => {
  it('ignores jobs with an unknown name', async () => {
    const { sut, send } = makeSut();
    const result = await sut.process(makeJob({ name: 'other' as never }));
    expect(result).toEqual({ ok: true, skipped: 'unknown_job' });
    expect(send).not.toHaveBeenCalled();
  });

  it('throws UnrecoverableError when no channel is configured', async () => {
    const { sut, findByPhoneNumberId } = makeSut();
    findByPhoneNumberId.mockResolvedValue(null);
    await expect(sut.process(makeJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError when the channel is disabled', async () => {
    const { sut, findByPhoneNumberId, send } = makeSut();
    findByPhoneNumberId.mockResolvedValue({ ...activeCreds, status: 'disabled' });
    await expect(sut.process(makeJob())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends with the resolved per-tenant token and version, returning the wamid', async () => {
    const { sut, findByPhoneNumberId, send } = makeSut();
    findByPhoneNumberId.mockResolvedValue(activeCreds);
    send.mockResolvedValue({ wamid: 'wamid.XYZ', status: 200, durationMs: 5 });

    const result = await sut.process(makeJob());

    expect(send).toHaveBeenCalledWith({
      jobId: 'j-1',
      phoneNumberId: '123',
      accessToken: 'TOKEN',
      version: 'v20.0',
      body: jobData.body,
    });
    expect(result).toEqual({ ok: true, wamid: 'wamid.XYZ', status: 200 });
  });

  it('propagates a retryable client error', async () => {
    const { sut, findByPhoneNumberId, send } = makeSut();
    findByPhoneNumberId.mockResolvedValue(activeCreds);
    send.mockRejectedValue(new Error('WhatsApp Cloud returned 503'));
    await expect(sut.process(makeJob())).rejects.toThrow('503');
  });
});
