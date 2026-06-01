import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { GhlContactClient, buildNamedCustomFields } from './ghl-contact-client';
import { AppEnv } from '../config/env.validation';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeClient() {
  const get = jest.fn();
  const put = jest.fn();
  mockedAxios.create.mockReturnValue({ get, put } as unknown as ReturnType<
    typeof axios.create
  >);

  const env: Record<string, string | number> = {
    GHL_API_BASE_URL: 'https://services.example.com',
    GHL_API_VERSION: '2021-07-28',
    GHL_API_TIMEOUT_MS: 5000,
  };
  const config = { get: (k: string) => env[k] } as unknown as ConfigService<AppEnv, true>;

  return { client: new GhlContactClient(config), get, put };
}

describe('GhlContactClient', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('constructor', () => {
    it('configures axios with the GHL baseURL, Version header and timeout', () => {
      makeClient();
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://services.example.com',
          timeout: 5000,
          headers: expect.objectContaining({
            Version: '2021-07-28',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });
  });

  describe('get', () => {
    it('GETs /contacts/:id with bearer auth and returns customFields + firstName (top-level shape)', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({
        status: 200,
        data: {
          firstName: 'Fabio',
          customFields: [
            { id: 'cf_1', value: 'Enabled' },
            { id: 'cf_2', value: 'Foo' },
          ],
        },
      });

      const result = await client.get({ jobId: 'j', contactId: 'c_1', apiKey: 'sk' });

      expect(get).toHaveBeenCalledWith('/contacts/c_1', {
        headers: { Authorization: 'Bearer sk' },
      });
      expect(result.status).toBe(200);
      expect(result.customFields).toEqual([
        { id: 'cf_1', value: 'Enabled' },
        { id: 'cf_2', value: 'Foo' },
      ]);
      expect(result.firstName).toBe('Fabio');
    });

    it('extracts customFields + firstName from nested contact wrapper', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({
        status: 200,
        data: {
          contact: {
            firstName: 'Fabio',
            customFields: [{ id: 'cf_1', value: 'X' }],
          },
        },
      });

      const result = await client.get({ jobId: 'j', contactId: 'c_1', apiKey: 'sk' });

      expect(result.customFields).toEqual([{ id: 'cf_1', value: 'X' }]);
      expect(result.firstName).toBe('Fabio');
    });

    it('trims firstName whitespace and returns undefined when blank', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValueOnce({
        status: 200,
        data: { firstName: '  Fabio  ', customFields: [] },
      });
      get.mockResolvedValueOnce({
        status: 200,
        data: { firstName: '   ', customFields: [] },
      });
      get.mockResolvedValueOnce({
        status: 200,
        data: { customFields: [] },
      });

      const trimmed = await client.get({ jobId: 'j', contactId: 'c_1', apiKey: 'sk' });
      const blank = await client.get({ jobId: 'j', contactId: 'c_2', apiKey: 'sk' });
      const missing = await client.get({ jobId: 'j', contactId: 'c_3', apiKey: 'sk' });

      expect(trimmed.firstName).toBe('Fabio');
      expect(blank.firstName).toBeUndefined();
      expect(missing.firstName).toBeUndefined();
    });

    it('returns customFields=[] when shape is unexpected', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({ status: 200, data: { customFields: 'oops' } });

      const result = await client.get({ jobId: 'j', contactId: 'c_1', apiKey: 'sk' });

      expect(result.customFields).toEqual([]);
    });

    it('skips entries without a string id', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({
        status: 200,
        data: {
          customFields: [
            { id: 'cf_1', value: 'A' },
            { value: 'no id' },
            { id: 42, value: 'numeric id' },
            null,
          ],
        },
      });

      const result = await client.get({ jobId: 'j', contactId: 'c_1', apiKey: 'sk' });

      expect(result.customFields).toEqual([{ id: 'cf_1', value: 'A' }]);
    });

    it('encodes special characters in the contactId path segment', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({ status: 200, data: { customFields: [] } });

      await client.get({ jobId: 'j', contactId: 'c/with space', apiKey: 'k' });

      expect(get.mock.calls[0][0]).toBe('/contacts/c%2Fwith%20space');
    });

    it('throws UnrecoverableError on 4xx', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({ status: 401, data: { error: 'unauthorized' } });

      await expect(
        client.get({ jobId: 'j', contactId: 'c', apiKey: 'k' }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('throws a regular Error on 5xx (retryable)', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({ status: 503, data: 'down' });

      const err = await client
        .get({ jobId: 'j', contactId: 'c', apiKey: 'k' })
        .catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnrecoverableError);
      expect(err.message).toMatch(/503/);
    });

    it('throws a regular Error on transport failure (retryable)', async () => {
      const { client, get } = makeClient();
      const transport = new Error('connect ETIMEDOUT') as AxiosError;
      transport.code = 'ETIMEDOUT';
      get.mockRejectedValue(transport);

      const err = await client
        .get({ jobId: 'j', contactId: 'c', apiKey: 'k' })
        .catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnrecoverableError);
      expect(err.message).toMatch(/ETIMEDOUT/);
    });
  });

  describe('disableAiField', () => {
    it('PUTs /contacts/:id with bearer auth and customFields body', async () => {
      const { client, put } = makeClient();
      put.mockResolvedValue({ status: 200, data: { ok: true } });

      const result = await client.disableAiField({
        jobId: 'job-1',
        contactId: 'c_1',
        apiKey: 'sk_xxx',
        aiField: { id: 'cf_1', key: 'ai_status' },
      });

      expect(put).toHaveBeenCalledWith(
        '/contacts/c_1',
        { customFields: [{ id: 'cf_1', key: 'ai_status', field_value: 'Disabled' }] },
        { headers: { Authorization: 'Bearer sk_xxx' } },
      );
      expect(result.status).toBe(200);
    });

    it('throws UnrecoverableError on 4xx', async () => {
      const { client, put } = makeClient();
      put.mockResolvedValue({ status: 400, data: { error: 'bad' } });

      await expect(
        client.disableAiField({
          jobId: 'job-1',
          contactId: 'c',
          apiKey: 'k',
          aiField: { id: 'i', key: 'k' },
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('throws a regular Error on 5xx (retryable)', async () => {
      const { client, put } = makeClient();
      put.mockResolvedValue({ status: 503, data: 'down' });

      const err = await client
        .disableAiField({
          jobId: 'job-1',
          contactId: 'c',
          apiKey: 'k',
          aiField: { id: 'i', key: 'k' },
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnrecoverableError);
      expect(err.message).toMatch(/503/);
    });

    it('throws a regular Error on transport failure (retryable)', async () => {
      const { client, put } = makeClient();
      const transport = new Error('connect ECONNREFUSED') as AxiosError;
      transport.code = 'ECONNREFUSED';
      put.mockRejectedValue(transport);

      const err = await client
        .disableAiField({
          jobId: 'job-1',
          contactId: 'c',
          apiKey: 'k',
          aiField: { id: 'i', key: 'k' },
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnrecoverableError);
      expect(err.message).toMatch(/ECONNREFUSED/);
    });
  });

  describe('listCustomFields', () => {
    it('GETs /locations/:id/customFields with bearer auth and returns an id→name map', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({
        status: 200,
        data: {
          customFields: [
            { id: 'cf_1', name: 'Nombre Cliente', fieldKey: 'contact.nombre' },
            { id: 'cf_2', name: 'Plan', fieldKey: 'contact.plan' },
          ],
        },
      });

      const defs = await client.listCustomFields({
        jobId: 'j',
        locationId: 'loc_1',
        apiKey: 'pit-xxx',
      });

      expect(get).toHaveBeenCalledWith('/locations/loc_1/customFields', {
        headers: { Authorization: 'Bearer pit-xxx' },
      });
      expect(defs.get('cf_1')).toBe('Nombre Cliente');
      expect(defs.get('cf_2')).toBe('Plan');
      expect(defs.size).toBe(2);
    });

    it('trims names and skips entries without a string id or non-blank name', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({
        status: 200,
        data: {
          customFields: [
            { id: 'cf_1', name: '  Plan  ' },
            { id: 'cf_2', name: '   ' },
            { id: 42, name: 'numeric id' },
            { name: 'no id' },
            null,
          ],
        },
      });

      const defs = await client.listCustomFields({ jobId: 'j', locationId: 'loc_1', apiKey: 'k' });

      expect(defs.size).toBe(1);
      expect(defs.get('cf_1')).toBe('Plan');
    });

    it('caches per location and does not re-fetch within the TTL', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({
        status: 200,
        data: { customFields: [{ id: 'cf_1', name: 'Plan' }] },
      });

      await client.listCustomFields({ jobId: 'j', locationId: 'loc_1', apiKey: 'k' });
      await client.listCustomFields({ jobId: 'j', locationId: 'loc_1', apiKey: 'k' });

      expect(get).toHaveBeenCalledTimes(1);
    });

    it('encodes special characters in the locationId path segment', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({ status: 200, data: { customFields: [] } });

      await client.listCustomFields({ jobId: 'j', locationId: 'loc/x y', apiKey: 'k' });

      expect(get.mock.calls[0][0]).toBe('/locations/loc%2Fx%20y/customFields');
    });

    it('throws UnrecoverableError on 4xx', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({ status: 401, data: { error: 'unauthorized' } });

      await expect(
        client.listCustomFields({ jobId: 'j', locationId: 'loc_1', apiKey: 'k' }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('throws a regular Error on 5xx (retryable)', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({ status: 503, data: 'down' });

      const err = await client
        .listCustomFields({ jobId: 'j', locationId: 'loc_1', apiKey: 'k' })
        .catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnrecoverableError);
      expect(err.message).toMatch(/503/);
    });

    it('throws a regular Error on transport failure (retryable)', async () => {
      const { client, get } = makeClient();
      const transport = new Error('connect ETIMEDOUT') as AxiosError;
      transport.code = 'ETIMEDOUT';
      get.mockRejectedValue(transport);

      const err = await client
        .listCustomFields({ jobId: 'j', locationId: 'loc_1', apiKey: 'k' })
        .catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnrecoverableError);
      expect(err.message).toMatch(/ETIMEDOUT/);
    });
  });

  describe('buildNamedCustomFields', () => {
    const defs = new Map([
      ['cf_1', 'Nombre Cliente'],
      ['cf_2', 'Plan'],
      ['cf_3', 'Edad'],
      ['cf_4', 'Activo'],
      ['cf_5', 'Intereses'],
    ]);

    it('joins values with names and drops fields with no definition', () => {
      const out = buildNamedCustomFields(
        [
          { id: 'cf_1', value: 'Juan' },
          { id: 'cf_2', value: 'Premium' },
          { id: 'cf_unknown', value: 'ignored' },
        ],
        defs,
      );

      expect(out).toEqual({ 'Nombre Cliente': 'Juan', Plan: 'Premium' });
    });

    it('normalizes numbers, booleans and arrays; trims strings; drops empties', () => {
      const out = buildNamedCustomFields(
        [
          { id: 'cf_1', value: '  Juan  ' },
          { id: 'cf_2', value: '' },
          { id: 'cf_3', value: 30 },
          { id: 'cf_4', value: true },
          { id: 'cf_5', value: ['rock', 'jazz'] },
        ],
        defs,
      );

      expect(out).toEqual({
        'Nombre Cliente': 'Juan',
        Edad: '30',
        Activo: 'true',
        Intereses: 'rock, jazz',
      });
    });

    it('drops object/null values that would not stringify meaningfully', () => {
      const out = buildNamedCustomFields(
        [
          { id: 'cf_1', value: null },
          { id: 'cf_2', value: { a: 1 } },
          { id: 'cf_3', value: undefined },
        ],
        defs,
      );

      expect(out).toEqual({});
    });

    it('last write wins on duplicate names', () => {
      const dupDefs = new Map([
        ['cf_1', 'Plan'],
        ['cf_2', 'Plan'],
      ]);
      const out = buildNamedCustomFields(
        [
          { id: 'cf_1', value: 'Basic' },
          { id: 'cf_2', value: 'Premium' },
        ],
        dupDefs,
      );

      expect(out).toEqual({ Plan: 'Premium' });
    });
  });
});
