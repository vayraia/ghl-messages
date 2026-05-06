import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { ChatRequest, WebhookForwarder } from './webhook-forwarder';
import { AppEnv } from '../config/env.validation';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeForwarder(overrides: Partial<Record<keyof AppEnv, string | number>> = {}) {
  const post = jest.fn();
  mockedAxios.create.mockReturnValue({ post } as unknown as ReturnType<typeof axios.create>);

  const env: Record<string, string | number> = {
    CHAT_API_URL: 'https://chat.example.com',
    CHAT_API_TIMEOUT_MS: 5000,
    ...overrides,
  };
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService<AppEnv, true>;

  return { forwarder: new WebhookForwarder(config), post };
}

const baseReq: ChatRequest = {
  jobId: 'job-1',
  agentId: 'ventas',
  contactId: 'c-1',
  body: 'hola\nbuen día',
  receivedAt: '2026-04-28T00:00:00.000Z',
  requestId: 'req-1',
};

describe('WebhookForwarder', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('configures axios with the chat baseURL and timeout, no auth header', () => {
    makeForwarder();
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://chat.example.com',
        timeout: 5000,
        headers: { 'content-type': 'application/json' },
        maxRedirects: 0,
      }),
    );
    const opts = mockedAxios.create.mock.calls[0][0]!;
    expect(opts.headers).not.toHaveProperty('authorization');
    expect(opts.headers).not.toHaveProperty('x-api-key');
  });

  it('POSTs to /chat with the contract body and trace headers', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({ status: 200, data: { message: 'ok' } });

    const result = await forwarder.forward(baseReq);

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, opts] = post.mock.calls[0];
    expect(url).toBe('/chat');
    expect(body).toEqual({
      agent_id: 'ventas',
      contact_id: 'c-1',
      contact_data: {},
      message: { body: 'hola\nbuen día' },
    });
    expect(opts.headers).toMatchObject({
      'x-webhook-job-id': 'job-1',
      'x-webhook-received-at': baseReq.receivedAt,
      'x-request-id': 'req-1',
    });
    expect(result.message).toBe('ok');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits contact_data.name when a contactName is provided', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({ status: 200, data: { message: 'ok' } });

    await forwarder.forward({ ...baseReq, contactName: 'Fabio Coronado' });

    const [, body] = post.mock.calls[0];
    expect(body).toEqual({
      agent_id: 'ventas',
      contact_id: 'c-1',
      contact_data: { name: 'Fabio Coronado' },
      message: { body: 'hola\nbuen día' },
    });
  });

  it('includes attachments in message when provided', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({ status: 200, data: { message: 'ok' } });

    await forwarder.forward({
      ...baseReq,
      attachments: ['https://files.gohighlevel/a.jpg', 'https://files.gohighlevel/b.pdf'],
    });

    const [, body] = post.mock.calls[0];
    expect(body.message).toEqual({
      body: 'hola\nbuen día',
      attachments: ['https://files.gohighlevel/a.jpg', 'https://files.gohighlevel/b.pdf'],
    });
  });

  it('omits attachments key when array is empty', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({ status: 200, data: { message: 'ok' } });

    await forwarder.forward({ ...baseReq, attachments: [] });

    const [, body] = post.mock.calls[0];
    expect(body.message).toEqual({ body: 'hola\nbuen día' });
    expect(body.message).not.toHaveProperty('attachments');
  });

  it('keeps contact_data empty when contactName is absent', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({ status: 200, data: { message: 'ok' } });

    await forwarder.forward(baseReq);

    const [, body] = post.mock.calls[0];
    expect(body.contact_data).toEqual({});
  });

  it('returns the message field from the chat response', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({ status: 200, data: { message: 'Hola, buenos días ☺️' } });

    const result = await forwarder.forward(baseReq);
    expect(result.message).toBe('Hola, buenos días ☺️');
  });

  it('throws UnrecoverableError on 2xx without a message field', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({ status: 200, data: { message: '' } });

    await expect(forwarder.forward(baseReq)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError on 4xx', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({ status: 422, data: { error: 'bad payload' } });

    await expect(forwarder.forward(baseReq)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws a regular Error on 5xx (retryable)', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({ status: 503, data: 'oh no' });

    const err = await forwarder.forward(baseReq).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(err.message).toMatch(/503/);
  });

  it('throws a regular Error on transport failure (retryable)', async () => {
    const { forwarder, post } = makeForwarder();
    const transportErr = new Error('connect ECONNREFUSED 127.0.0.1:9999') as AxiosError;
    transportErr.code = 'ECONNREFUSED';
    post.mockRejectedValue(transportErr);

    const err = await forwarder.forward(baseReq).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(err.message).toMatch(/ECONNREFUSED/);
  });

  it('truncates large response bodies in error messages', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({ status: 500, data: 'x'.repeat(2000) });

    const err = await forwarder.forward(baseReq).catch((e) => e);
    expect(err.message.length).toBeLessThan(700);
    expect(err.message).toMatch(/…/);
  });
});
