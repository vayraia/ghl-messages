import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { UnrecoverableError } from 'bullmq';
import {
  GhlReply,
  GhlReplyInput,
  inferImageMimeType,
  inferDocumentMimeType,
  basenameFromUrl,
} from './ghl-reply';
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

  it('sends the structured whatsapp.media body with fromNumberId when provided', async () => {
    const { ghl, post } = makeGhl();
    post.mockResolvedValue({ status: 201, data: { ok: true } });

    await ghl.send({
      ...baseInput,
      message: 'Prueba mensaje',
      locationId: 'wfS46PMu1sOToYyj38Mq',
      whatsappMedia: {
        type: 'image',
        url: 'https://assets.cdn.filesafe.space/loc/media/abc.jpg',
        caption: 'Prueba mensaje',
        mimeType: 'image/jpeg',
        fromNumberId: '1130377746823770',
      },
    });

    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/conversations/messages');
    expect(body).toEqual({
      contactId: 'c-1',
      locationId: 'wfS46PMu1sOToYyj38Mq',
      type: 'WhatsApp',
      message: 'Prueba mensaje',
      whatsapp: {
        type: 'media',
        fromNumberId: '1130377746823770',
        media: {
          type: 'image',
          url: 'https://assets.cdn.filesafe.space/loc/media/abc.jpg',
          caption: 'Prueba mensaje',
          mimeType: 'image/jpeg',
        },
      },
    });
    // The structured body must NOT carry the flat attachments key.
    expect(body).not.toHaveProperty('attachments');
  });

  it('omits fromNumberId from the whatsapp block when not provided', async () => {
    const { ghl, post } = makeGhl();
    post.mockResolvedValue({ status: 201, data: { ok: true } });

    await ghl.send({
      ...baseInput,
      locationId: 'loc-1',
      whatsappMedia: {
        type: 'image',
        url: 'https://cdn.app.com/img.png',
        caption: '',
        mimeType: 'image/png',
      },
    });

    const [, body] = post.mock.calls[0];
    expect(body.whatsapp).not.toHaveProperty('fromNumberId');
    expect(body.whatsapp.media).toEqual({
      type: 'image',
      url: 'https://cdn.app.com/img.png',
      caption: '',
      mimeType: 'image/png',
    });
  });

  it('sends the structured whatsapp.media document body with name and fromNumberId', async () => {
    const { ghl, post } = makeGhl();
    post.mockResolvedValue({ status: 201, data: { ok: true } });

    await ghl.send({
      ...baseInput,
      message: 'Prueba mensje con pdf',
      locationId: 'wfS46PMu1sOToYyj38Mq',
      whatsappMedia: {
        type: 'document',
        name: 'sample.pdf',
        url: 'https://assets.cdn.filesafe.space/loc/media/abc.pdf',
        caption: 'Prueba mensje con pdf',
        mimeType: 'application/pdf',
        fromNumberId: '1130377746823770',
      },
    });

    const [, body] = post.mock.calls[0];
    expect(body).toEqual({
      contactId: 'c-1',
      locationId: 'wfS46PMu1sOToYyj38Mq',
      type: 'WhatsApp',
      message: 'Prueba mensje con pdf',
      whatsapp: {
        type: 'media',
        fromNumberId: '1130377746823770',
        media: {
          type: 'document',
          name: 'sample.pdf',
          url: 'https://assets.cdn.filesafe.space/loc/media/abc.pdf',
          caption: 'Prueba mensje con pdf',
          mimeType: 'application/pdf',
        },
      },
    });
    expect(body).not.toHaveProperty('attachments');
  });

  it('omits media.name when the document has no name', async () => {
    const { ghl, post } = makeGhl();
    post.mockResolvedValue({ status: 201, data: { ok: true } });

    await ghl.send({
      ...baseInput,
      locationId: 'loc-1',
      whatsappMedia: {
        type: 'document',
        url: 'https://cdn.app.com/doc.pdf',
        caption: '',
        mimeType: 'application/pdf',
        name: '',
      },
    });

    const [, body] = post.mock.calls[0];
    expect(body.whatsapp.media).not.toHaveProperty('name');
    expect(body.whatsapp).not.toHaveProperty('fromNumberId');
  });

  describe('inferDocumentMimeType', () => {
    it.each([
      ['https://cdn.app.com/a.pdf', 'application/pdf'],
      ['https://cdn.app.com/a.PDF', 'application/pdf'],
      ['https://cdn.app.com/a.doc', 'application/msword'],
      [
        'https://cdn.app.com/a.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      ['https://cdn.app.com/a.xls', 'application/vnd.ms-excel'],
      [
        'https://cdn.app.com/a.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ],
      ['https://cdn.app.com/a.csv', 'text/csv'],
      ['https://cdn.app.com/a.zip', 'application/zip'],
      ['https://cdn.app.com/a.pdf?sig=abc', 'application/pdf'],
      ['https://cdn.app.com/a', 'application/octet-stream'],
      ['https://cdn.app.com/a.xyz', 'application/octet-stream'],
    ])('maps %s to %s', (url, expected) => {
      expect(inferDocumentMimeType(url)).toBe(expected);
    });
  });

  describe('basenameFromUrl', () => {
    it.each([
      ['https://cdn.app.com/docs/cotizacion-1234.pdf', 'cotizacion-1234.pdf'],
      ['https://cdn.app.com/media/abc.pdf?sig=x&y=1', 'abc.pdf'],
      ['https://cdn.app.com/a.pdf#frag', 'a.pdf'],
      ['https://cdn.app.com/trailing/', ''],
    ])('extracts the basename of %s as %s', (url, expected) => {
      expect(basenameFromUrl(url)).toBe(expected);
    });
  });

  describe('inferImageMimeType', () => {
    it.each([
      ['https://cdn.app.com/a.jpg', 'image/jpeg'],
      ['https://cdn.app.com/a.jpeg', 'image/jpeg'],
      ['https://cdn.app.com/a.JPG', 'image/jpeg'],
      ['https://cdn.app.com/a.png', 'image/png'],
      ['https://cdn.app.com/a.webp', 'image/webp'],
      ['https://cdn.app.com/a.gif', 'image/gif'],
      ['https://cdn.app.com/a.png?v=123&x=1', 'image/png'],
      ['https://cdn.app.com/a', 'image/jpeg'],
      ['https://cdn.app.com/a.bmp', 'image/jpeg'],
    ])('maps %s to %s', (url, expected) => {
      expect(inferImageMimeType(url)).toBe(expected);
    });
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
