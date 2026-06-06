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
  locationId: 'loc_abc',
  apiKey: 'pit-xxx',
  body: 'hola\nbuen día',
  channel: 'WhatsApp',
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
    post.mockResolvedValue({
      status: 200,
      data: { messages: [{ type: 'text', content: 'ok' }] },
    });

    const result = await forwarder.forward(baseReq);

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, opts] = post.mock.calls[0];
    expect(url).toBe('/chat');
    expect(body).toEqual({
      agent_id: 'ventas',
      contact_id: 'c-1',
      contact_data: { ghl_token: 'pit-xxx', location_id: 'loc_abc' },
      message: { body: 'hola\nbuen día', type: 'WhatsApp' },
    });
    expect(opts.headers).toMatchObject({
      'x-webhook-job-id': 'job-1',
      'x-webhook-received-at': baseReq.receivedAt,
      'x-request-id': 'req-1',
    });
    expect(result.messages).toEqual([{ type: 'text', content: 'ok' }]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits contact_data.name when a contactName is provided', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({
      status: 200,
      data: { messages: [{ type: 'text', content: 'ok' }] },
    });

    await forwarder.forward({ ...baseReq, contactName: 'Fabio Coronado' });

    const [, body] = post.mock.calls[0];
    expect(body).toEqual({
      agent_id: 'ventas',
      contact_id: 'c-1',
      contact_data: {
        ghl_token: 'pit-xxx',
        location_id: 'loc_abc',
        name: 'Fabio Coronado',
      },
      message: { body: 'hola\nbuen día', type: 'WhatsApp' },
    });
  });

  it('sends custom fields as a structured custom_fields array', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({
      status: 200,
      data: { messages: [{ type: 'text', content: 'ok' }] },
    });

    await forwarder.forward({
      ...baseReq,
      contactName: 'Fabio',
      customFields: [
        { id: 'cf_1', name: 'Reprogramar Cita', value: 'https://app.vayraperu.com/widget/booking/x' },
        { id: 'cf_2', name: 'Nombre Cliente', value: 'Juan' },
      ],
    });

    const [, body] = post.mock.calls[0];
    expect(body.contact_data).toEqual({
      ghl_token: 'pit-xxx',
      location_id: 'loc_abc',
      name: 'Fabio',
      custom_fields: [
        { id: 'cf_1', name: 'Reprogramar Cita', value: 'https://app.vayraperu.com/widget/booking/x' },
        { id: 'cf_2', name: 'Nombre Cliente', value: 'Juan' },
      ],
    });
  });

  it('omits custom_fields when the array is empty or absent', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({
      status: 200,
      data: { messages: [{ type: 'text', content: 'ok' }] },
    });

    await forwarder.forward({ ...baseReq, customFields: [] });

    const [, body] = post.mock.calls[0];
    expect(body.contact_data).toEqual({ ghl_token: 'pit-xxx', location_id: 'loc_abc' });
    expect(body.contact_data).not.toHaveProperty('custom_fields');
  });

  it('never lets a custom field collide with the reserved contact_data keys', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({
      status: 200,
      data: { messages: [{ type: 'text', content: 'ok' }] },
    });

    await forwarder.forward({
      ...baseReq,
      contactName: 'Fabio',
      // Oddly named fields live under custom_fields and cannot touch the
      // reserved top-level keys.
      customFields: [
        { id: 'cf_1', name: 'ghl_token', value: 'HACKED' },
        { id: 'cf_2', name: 'location_id', value: 'HACKED' },
        { id: 'cf_3', name: 'name', value: 'HACKED' },
      ],
    });

    const [, body] = post.mock.calls[0];
    expect(body.contact_data).toMatchObject({
      ghl_token: 'pit-xxx',
      location_id: 'loc_abc',
      name: 'Fabio',
    });
    expect(body.contact_data.custom_fields).toEqual([
      { id: 'cf_1', name: 'ghl_token', value: 'HACKED' },
      { id: 'cf_2', name: 'location_id', value: 'HACKED' },
      { id: 'cf_3', name: 'name', value: 'HACKED' },
    ]);
  });

  it('includes attachments in message when provided', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({
      status: 200,
      data: { messages: [{ type: 'text', content: 'ok' }] },
    });

    await forwarder.forward({
      ...baseReq,
      attachments: ['https://files.gohighlevel/a.jpg', 'https://files.gohighlevel/b.pdf'],
    });

    const [, body] = post.mock.calls[0];
    expect(body.message).toEqual({
      body: 'hola\nbuen día',
      type: 'WhatsApp',
      attachments: ['https://files.gohighlevel/a.jpg', 'https://files.gohighlevel/b.pdf'],
    });
  });

  it('omits attachments key when array is empty', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({
      status: 200,
      data: { messages: [{ type: 'text', content: 'ok' }] },
    });

    await forwarder.forward({ ...baseReq, attachments: [] });

    const [, body] = post.mock.calls[0];
    expect(body.message).toEqual({ body: 'hola\nbuen día', type: 'WhatsApp' });
    expect(body.message).not.toHaveProperty('attachments');
  });

  it('omits contact_data.name when contactName is absent but keeps token + location', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({
      status: 200,
      data: { messages: [{ type: 'text', content: 'ok' }] },
    });

    await forwarder.forward(baseReq);

    const [, body] = post.mock.calls[0];
    expect(body.contact_data).toEqual({
      ghl_token: 'pit-xxx',
      location_id: 'loc_abc',
    });
    expect(body.contact_data).not.toHaveProperty('name');
  });

  it('parses a multi-message reply preserving order and per-type fields', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({
      status: 200,
      data: {
        messages: [
          { type: 'text', content: 'Encontré 3 opciones para vos.' },
          { type: 'image', url: 'https://cdn.app.com/img1.jpg', caption: 'Modelo A' },
          { type: 'text', content: 'Este tiene mejor batería.' },
          { type: 'file', url: 'https://cdn.app.com/specs.pdf', filename: 'specs.pdf' },
        ],
      },
    });

    const result = await forwarder.forward(baseReq);

    expect(result.messages).toEqual([
      { type: 'text', content: 'Encontré 3 opciones para vos.' },
      { type: 'image', url: 'https://cdn.app.com/img1.jpg', caption: 'Modelo A' },
      { type: 'text', content: 'Este tiene mejor batería.' },
      { type: 'file', url: 'https://cdn.app.com/specs.pdf', filename: 'specs.pdf' },
    ]);
  });

  it('parses image without caption and file without filename', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({
      status: 200,
      data: {
        messages: [
          { type: 'image', url: 'https://cdn.app.com/x.jpg' },
          { type: 'file', url: 'https://cdn.app.com/y.pdf' },
        ],
      },
    });

    const result = await forwarder.forward(baseReq);
    expect(result.messages).toEqual([
      { type: 'image', url: 'https://cdn.app.com/x.jpg' },
      { type: 'file', url: 'https://cdn.app.com/y.pdf' },
    ]);
  });

  it('throws UnrecoverableError on 2xx without a messages field', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({ status: 200, data: { something: 'else' } });

    await expect(forwarder.forward(baseReq)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError on 2xx with an empty messages array', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({ status: 200, data: { messages: [] } });

    await expect(forwarder.forward(baseReq)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError when a text entry has empty content', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({
      status: 200,
      data: { messages: [{ type: 'text', content: '   ' }] },
    });

    await expect(forwarder.forward(baseReq)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError when an image entry has no url', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({
      status: 200,
      data: { messages: [{ type: 'image', caption: 'no url' }] },
    });

    await expect(forwarder.forward(baseReq)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError when an entry has an unknown type', async () => {
    const { forwarder, post } = makeForwarder();
    post.mockResolvedValue({
      status: 200,
      data: { messages: [{ type: 'audio', url: 'x' }] },
    });

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
