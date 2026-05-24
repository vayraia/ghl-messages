import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { WhatsAppCloudClient, WhatsAppSendInput } from './whatsapp-cloud-client';
import { CloudApiSendBody } from './whatsapp-message';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeClient(overrides: Partial<Record<keyof AppEnv, string | number>> = {}) {
  const post = jest.fn();
  mockedAxios.create.mockReturnValue({ post } as unknown as ReturnType<typeof axios.create>);

  const env: Record<string, string | number> = {
    GRAPH_API_BASE_URL: 'https://graph.facebook.com',
    GRAPH_API_VERSION: 'v21.0',
    GRAPH_API_TIMEOUT_MS: 10000,
    ...overrides,
  };
  const config = { get: (key: string) => env[key] } as unknown as ConfigService<AppEnv, true>;
  return { client: new WhatsAppCloudClient(config), post };
}

const body: CloudApiSendBody = {
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: '5493510000000',
  type: 'text',
  text: { body: 'hola' },
};

const baseInput: WhatsAppSendInput = {
  jobId: 'j-1',
  phoneNumberId: '123456',
  accessToken: 'EAAtoken',
  body,
};

describe('WhatsAppCloudClient', () => {
  beforeEach(() => jest.clearAllMocks());

  it('configures axios with validateStatus passthrough and no shared Authorization', () => {
    makeClient();
    const opts = mockedAxios.create.mock.calls[0][0]!;
    expect(opts).toMatchObject({
      baseURL: 'https://graph.facebook.com',
      timeout: 10000,
      maxRedirects: 0,
    });
    expect(typeof opts.validateStatus).toBe('function');
    expect(opts.headers).not.toHaveProperty('Authorization');
  });

  it('POSTs to /{version}/{phoneNumberId}/messages with a per-call Bearer and returns the wamid', async () => {
    const { client, post } = makeClient();
    post.mockResolvedValue({ status: 200, data: { messages: [{ id: 'wamid.ABC' }] } });

    const result = await client.send(baseInput);

    const [url, sent, opts] = post.mock.calls[0];
    expect(url).toBe('/v21.0/123456/messages');
    expect(sent).toBe(body);
    expect(opts).toEqual({ headers: { Authorization: 'Bearer EAAtoken' } });
    expect(result.wamid).toBe('wamid.ABC');
    expect(result.status).toBe(200);
  });

  it('uses the per-tenant version override when provided', async () => {
    const { client, post } = makeClient();
    post.mockResolvedValue({ status: 200, data: { messages: [{ id: 'w' }] } });

    await client.send({ ...baseInput, version: 'v19.0' });

    expect(post.mock.calls[0][0]).toBe('/v19.0/123456/messages');
  });

  it('returns undefined wamid when the response has no messages', async () => {
    const { client, post } = makeClient();
    post.mockResolvedValue({ status: 200, data: {} });
    const result = await client.send(baseInput);
    expect(result.wamid).toBeUndefined();
  });

  it('throws UnrecoverableError on 401 (bad token)', async () => {
    const { client, post } = makeClient();
    post.mockResolvedValue({ status: 401, data: { error: { code: 190, message: 'bad token' } } });
    await expect(client.send(baseInput)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError on the 24h re-engagement window error (131047)', async () => {
    const { client, post } = makeClient();
    post.mockResolvedValue({
      status: 400,
      data: { error: { code: 131047, message: 'Re-engagement message' } },
    });
    await expect(client.send(baseInput)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('treats a 4xx rate-limit code (130429) as retryable', async () => {
    const { client, post } = makeClient();
    post.mockResolvedValue({
      status: 400,
      data: { error: { code: 130429, message: 'rate limit' } },
    });
    const err = await client.send(baseInput).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it('throws a retryable Error on 429 and on 5xx', async () => {
    const { client, post } = makeClient();
    post.mockResolvedValue({ status: 429, data: { error: { code: 0 } } });
    let err = await client.send(baseInput).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);

    post.mockResolvedValue({ status: 503, data: 'unavailable' });
    err = await client.send(baseInput).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it('throws a retryable Error on transport failure', async () => {
    const { client, post } = makeClient();
    const transportErr = new Error('ETIMEDOUT') as AxiosError;
    transportErr.code = 'ETIMEDOUT';
    post.mockRejectedValue(transportErr);

    const err = await client.send(baseInput).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });
});
