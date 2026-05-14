import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { GhlReply, GhlReplyInput } from './ghl-reply';
import { AppEnv } from '../config/env.validation';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeGhl(overrides: Partial<Record<keyof AppEnv, string | number>> = {}) {
  const post = jest.fn();
  mockedAxios.create.mockReturnValue({ post } as unknown as ReturnType<typeof axios.create>);

  const env: Record<string, string | number> = {
    GHL_API_BASE_URL: 'https://services.leadconnectorhq.com',
    GHL_API_VERSION: '2021-07-28',
    GHL_API_TIMEOUT_MS: 5000,
    ...overrides,
  };
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService<AppEnv, true>;

  return { ghl: new GhlReply(config), post };
}

const baseInput: GhlReplyInput = {
  jobId: 'j-1',
  contactId: 'c-1',
  message: 'Hola',
  type: 'WhatsApp',
  apiKey: 'pit-loc-key',
};

describe('GhlReply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('configures axios with Version and JSON content-type but no Authorization', () => {
    makeGhl();
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://services.leadconnectorhq.com',
        timeout: 5000,
        headers: {
          Version: '2021-07-28',
          'Content-Type': 'application/json',
        },
        maxRedirects: 0,
      }),
    );
    const opts = mockedAxios.create.mock.calls[0][0]!;
    expect(opts.headers).not.toHaveProperty('Authorization');
    expect(opts.headers).not.toHaveProperty('authorization');
  });

  it('POSTs to /conversations/messages with contactId, message, type and per-call Bearer', async () => {
    const { ghl, post } = makeGhl();
    post.mockResolvedValue({ status: 201, data: { ok: true } });

    const result = await ghl.send(baseInput);

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, opts] = post.mock.calls[0];
    expect(url).toBe('/conversations/messages');
    expect(body).toEqual({ contactId: 'c-1', message: 'Hola', type: 'WhatsApp' });
    expect(opts).toEqual({ headers: { Authorization: 'Bearer pit-loc-key' } });
    expect(result.status).toBe(201);
  });

  it('includes attachments in the body when provided', async () => {
    const { ghl, post } = makeGhl();
    post.mockResolvedValue({ status: 201, data: { ok: true } });

    await ghl.send({
      ...baseInput,
      attachments: ['https://cdn.app.com/img1.jpg'],
    });

    const [, body] = post.mock.calls[0];
    expect(body).toEqual({
      contactId: 'c-1',
      message: 'Hola',
      type: 'WhatsApp',
      attachments: ['https://cdn.app.com/img1.jpg'],
    });
  });

  it('omits attachments from the body when the array is empty', async () => {
    const { ghl, post } = makeGhl();
    post.mockResolvedValue({ status: 201, data: { ok: true } });

    await ghl.send({ ...baseInput, attachments: [] });

    const [, body] = post.mock.calls[0];
    expect(body).not.toHaveProperty('attachments');
  });

  it('uses a different Bearer token for a different apiKey', async () => {
    const { ghl, post } = makeGhl();
    post.mockResolvedValue({ status: 201, data: {} });

    await ghl.send({ ...baseInput, apiKey: 'another-key' });

    const [, , opts] = post.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer another-key');
  });

  it('throws UnrecoverableError on 4xx', async () => {
    const { ghl, post } = makeGhl();
    post.mockResolvedValue({ status: 401, data: { error: 'unauthorized' } });

    await expect(ghl.send({ ...baseInput, type: 'IG' })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('throws a regular Error on 5xx', async () => {
    const { ghl, post } = makeGhl();
    post.mockResolvedValue({ status: 502, data: 'bad gateway' });

    const err = await ghl.send({ ...baseInput, type: 'FB' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it('throws a regular Error on transport failure', async () => {
    const { ghl, post } = makeGhl();
    const transportErr = new Error('ETIMEDOUT') as AxiosError;
    transportErr.code = 'ETIMEDOUT';
    post.mockRejectedValue(transportErr);

    const err = await ghl.send(baseInput).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });
});
