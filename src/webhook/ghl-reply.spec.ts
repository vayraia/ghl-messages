import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { GhlReply } from './ghl-reply';
import { AppEnv } from '../config/env.validation';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeGhl(overrides: Partial<Record<keyof AppEnv, string | number>> = {}) {
  const post = jest.fn();
  mockedAxios.create.mockReturnValue({ post } as unknown as ReturnType<typeof axios.create>);

  const env: Record<string, string | number> = {
    GHL_API_BASE_URL: 'https://services.leadconnectorhq.com',
    GHL_API_KEY: 'ghl-secret',
    GHL_API_VERSION: '2021-07-28',
    GHL_API_TIMEOUT_MS: 5000,
    ...overrides,
  };
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService<AppEnv, true>;

  return { ghl: new GhlReply(config), post };
}

describe('GhlReply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('configures axios with Bearer auth, Version, and JSON content-type', () => {
    makeGhl();
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://services.leadconnectorhq.com',
        timeout: 5000,
        headers: {
          Authorization: 'Bearer ghl-secret',
          Version: '2021-07-28',
          'Content-Type': 'application/json',
        },
        maxRedirects: 0,
      }),
    );
  });

  it('POSTs to /conversations/messages with contactId, message, type', async () => {
    const { ghl, post } = makeGhl();
    post.mockResolvedValue({ status: 201, data: { ok: true } });

    const result = await ghl.send({
      jobId: 'j-1',
      contactId: 'c-1',
      message: 'Hola',
      type: 'WhatsApp',
    });

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/conversations/messages');
    expect(body).toEqual({ contactId: 'c-1', message: 'Hola', type: 'WhatsApp' });
    expect(result.status).toBe(201);
  });

  it('throws UnrecoverableError on 4xx', async () => {
    const { ghl, post } = makeGhl();
    post.mockResolvedValue({ status: 401, data: { error: 'unauthorized' } });

    await expect(
      ghl.send({ jobId: 'j', contactId: 'c', message: 'x', type: 'IG' }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws a regular Error on 5xx', async () => {
    const { ghl, post } = makeGhl();
    post.mockResolvedValue({ status: 502, data: 'bad gateway' });

    const err = await ghl
      .send({ jobId: 'j', contactId: 'c', message: 'x', type: 'FB' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it('throws a regular Error on transport failure', async () => {
    const { ghl, post } = makeGhl();
    const transportErr = new Error('ETIMEDOUT') as AxiosError;
    transportErr.code = 'ETIMEDOUT';
    post.mockRejectedValue(transportErr);

    const err = await ghl
      .send({ jobId: 'j', contactId: 'c', message: 'x', type: 'WhatsApp' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });
});
