import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { UnrecoverableError } from 'bullmq';
import {
  GhlContactClient,
  buildNamedCustomFields,
  resolveFieldValueByKey,
} from './ghl-contact-client';
import { AppEnv } from '../config/env.validation';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeClient() {
  const get = jest.fn();
  const put = jest.fn();
  mockedAxios.create.mockReturnValue({ get, put } as unknown as ReturnType<typeof axios.create>);

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

    it('extracts assignedTo (top-level and nested) and omits it when blank/missing', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValueOnce({
        status: 200,
        data: { assignedTo: 'QulqSPUfFcNHSIfoHdVR', customFields: [] },
      });
      get.mockResolvedValueOnce({
        status: 200,
        data: { contact: { assignedTo: '  user_2  ', customFields: [] } },
      });
      get.mockResolvedValueOnce({
        status: 200,
        data: { assignedTo: '   ', customFields: [] },
      });
      get.mockResolvedValueOnce({ status: 200, data: { customFields: [] } });

      const top = await client.get({ jobId: 'j', contactId: 'c_1', apiKey: 'k' });
      const nested = await client.get({ jobId: 'j', contactId: 'c_2', apiKey: 'k' });
      const blank = await client.get({ jobId: 'j', contactId: 'c_3', apiKey: 'k' });
      const missing = await client.get({ jobId: 'j', contactId: 'c_4', apiKey: 'k' });

      expect(top.assignedTo).toBe('QulqSPUfFcNHSIfoHdVR');
      expect(nested.assignedTo).toBe('user_2');
      expect(blank.assignedTo).toBeUndefined();
      expect(missing.assignedTo).toBeUndefined();
    });

    it('extracts email/phone (top-level and nested), trimming and omitting blanks', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValueOnce({
        status: 200,
        data: { email: '  fabio@example.com  ', phone: '+51987654321', customFields: [] },
      });
      get.mockResolvedValueOnce({
        status: 200,
        data: { contact: { email: 'nested@example.com', phone: '  +1555  ', customFields: [] } },
      });
      get.mockResolvedValueOnce({
        status: 200,
        data: { email: '   ', phone: '   ', customFields: [] },
      });
      get.mockResolvedValueOnce({ status: 200, data: { customFields: [] } });

      const top = await client.get({ jobId: 'j', contactId: 'c_1', apiKey: 'k' });
      const nested = await client.get({ jobId: 'j', contactId: 'c_2', apiKey: 'k' });
      const blank = await client.get({ jobId: 'j', contactId: 'c_3', apiKey: 'k' });
      const missing = await client.get({ jobId: 'j', contactId: 'c_4', apiKey: 'k' });

      expect(top.email).toBe('fabio@example.com');
      expect(top.phone).toBe('+51987654321');
      expect(nested.email).toBe('nested@example.com');
      expect(nested.phone).toBe('+1555');
      expect(blank.email).toBeUndefined();
      expect(blank.phone).toBeUndefined();
      expect(missing.email).toBeUndefined();
      expect(missing.phone).toBeUndefined();
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

      await expect(client.get({ jobId: 'j', contactId: 'c', apiKey: 'k' })).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    });

    it('throws a regular Error on 5xx (retryable)', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({ status: 503, data: 'down' });

      const err = await client.get({ jobId: 'j', contactId: 'c', apiKey: 'k' }).catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnrecoverableError);
      expect(err.message).toMatch(/503/);
    });

    it('throws a regular Error on transport failure (retryable)', async () => {
      const { client, get } = makeClient();
      const transport = new Error('connect ETIMEDOUT') as AxiosError;
      transport.code = 'ETIMEDOUT';
      get.mockRejectedValue(transport);

      const err = await client.get({ jobId: 'j', contactId: 'c', apiKey: 'k' }).catch((e) => e);

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

  describe('getUser', () => {
    it('GETs /users/:id with bearer auth and returns { id, name, email, phone }', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({
        status: 200,
        data: {
          id: 'QulqSPUfFcNHSIfoHdVR',
          name: 'Maria Lopez',
          email: 'maria@example.com',
          phone: '+51987654321',
        },
      });

      const user = await client.getUser({
        jobId: 'j',
        userId: 'QulqSPUfFcNHSIfoHdVR',
        apiKey: 'pit-xxx',
      });

      expect(get).toHaveBeenCalledWith('/users/QulqSPUfFcNHSIfoHdVR', {
        headers: { Authorization: 'Bearer pit-xxx' },
      });
      expect(user).toEqual({
        id: 'QulqSPUfFcNHSIfoHdVR',
        name: 'Maria Lopez',
        email: 'maria@example.com',
        phone: '+51987654321',
      });
    });

    it('omits phone when it is absent or blank', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValueOnce({ status: 200, data: { id: 'u1', name: 'Maria', phone: '   ' } });
      get.mockResolvedValueOnce({ status: 200, data: { id: 'u2', name: 'Maria' } });

      const blank = await client.getUser({ jobId: 'j', userId: 'u1', apiKey: 'k' });
      const missing = await client.getUser({ jobId: 'j', userId: 'u2', apiKey: 'k' });

      expect(blank).not.toHaveProperty('phone');
      expect(missing).not.toHaveProperty('phone');
    });

    it('falls back to firstName/lastName when name is absent', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({
        status: 200,
        data: { id: 'u1', firstName: 'Maria', lastName: 'Lopez' },
      });

      const user = await client.getUser({ jobId: 'j', userId: 'u1', apiKey: 'k' });

      expect(user).toEqual({ id: 'u1', name: 'Maria Lopez' });
    });

    it('reads from a nested user wrapper and omits blank email/name', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({
        status: 200,
        data: { user: { id: 'u1', name: '  ', email: '   ' } },
      });

      const user = await client.getUser({ jobId: 'j', userId: 'u1', apiKey: 'k' });

      expect(user).toEqual({ id: 'u1' });
    });

    it('falls back to the requested userId when the response omits id', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({ status: 200, data: { name: 'Maria' } });

      const user = await client.getUser({ jobId: 'j', userId: 'u1', apiKey: 'k' });

      expect(user).toEqual({ id: 'u1', name: 'Maria' });
    });

    it('caches per user id and does not re-fetch within the TTL', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({ status: 200, data: { id: 'u1', name: 'Maria' } });

      await client.getUser({ jobId: 'j', userId: 'u1', apiKey: 'k' });
      await client.getUser({ jobId: 'j', userId: 'u1', apiKey: 'k' });

      expect(get).toHaveBeenCalledTimes(1);
    });

    it('encodes special characters in the userId path segment', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({ status: 200, data: { id: 'u', name: 'X' } });

      await client.getUser({ jobId: 'j', userId: 'u/x y', apiKey: 'k' });

      expect(get.mock.calls[0][0]).toBe('/users/u%2Fx%20y');
    });

    it('throws UnrecoverableError on 4xx', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({ status: 404, data: { error: 'not found' } });

      await expect(
        client.getUser({ jobId: 'j', userId: 'u1', apiKey: 'k' }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('throws a regular Error on 5xx (retryable)', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({ status: 503, data: 'down' });

      const err = await client.getUser({ jobId: 'j', userId: 'u1', apiKey: 'k' }).catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnrecoverableError);
      expect(err.message).toMatch(/503/);
    });

    it('throws a regular Error on transport failure (retryable)', async () => {
      const { client, get } = makeClient();
      const transport = new Error('connect ETIMEDOUT') as AxiosError;
      transport.code = 'ETIMEDOUT';
      get.mockRejectedValue(transport);

      const err = await client.getUser({ jobId: 'j', userId: 'u1', apiKey: 'k' }).catch((e) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnrecoverableError);
      expect(err.message).toMatch(/ETIMEDOUT/);
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

  describe('listFieldDefs', () => {
    it('returns both id→name and lowercased fieldKey→id maps', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({
        status: 200,
        data: {
          customFields: [
            { id: 'cf_1', name: 'AI Agent', fieldKey: 'contact.AiAgent' },
            { id: 'cf_2', name: 'Plan', fieldKey: 'contact.plan' },
            { id: 'cf_3', name: 'No key' },
          ],
        },
      });

      const defs = await client.listFieldDefs({ jobId: 'j', locationId: 'loc_1', apiKey: 'k' });

      expect(defs.idToName.get('cf_1')).toBe('AI Agent');
      expect(defs.keyToId.get('contact.aiagent')).toBe('cf_1');
      expect(defs.keyToId.get('contact.plan')).toBe('cf_2');
      expect(defs.keyToId.has('cf_3')).toBe(false);
    });

    it('shares the per-location cache with listCustomFields', async () => {
      const { client, get } = makeClient();
      get.mockResolvedValue({
        status: 200,
        data: { customFields: [{ id: 'cf_1', name: 'Plan', fieldKey: 'contact.plan' }] },
      });

      await client.listFieldDefs({ jobId: 'j', locationId: 'loc_1', apiKey: 'k' });
      await client.listCustomFields({ jobId: 'j', locationId: 'loc_1', apiKey: 'k' });

      expect(get).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveFieldValueByKey', () => {
    const keyToId = new Map([['contact.aiagent', 'cf_ai']]);

    it('returns the normalized value of the field matching the key', () => {
      const value = resolveFieldValueByKey(
        [{ id: 'cf_ai', value: '  agent_x  ' }],
        keyToId,
        'contact.aiagent',
      );
      expect(value).toBe('agent_x');
    });

    it('matches the key case-insensitively', () => {
      const value = resolveFieldValueByKey(
        [{ id: 'cf_ai', value: 'agent_x' }],
        keyToId,
        'Contact.AiAgent',
      );
      expect(value).toBe('agent_x');
    });

    it('returns undefined when the key is unknown', () => {
      expect(
        resolveFieldValueByKey([{ id: 'cf_ai', value: 'agent_x' }], keyToId, 'contact.other'),
      ).toBeUndefined();
    });

    it('returns undefined when the contact has no field with that id', () => {
      expect(
        resolveFieldValueByKey([{ id: 'cf_other', value: 'x' }], keyToId, 'contact.aiagent'),
      ).toBeUndefined();
    });

    it('returns undefined when the value is blank', () => {
      expect(
        resolveFieldValueByKey([{ id: 'cf_ai', value: '   ' }], keyToId, 'contact.aiagent'),
      ).toBeUndefined();
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

    it('pairs id, name and value and drops fields with no definition', () => {
      const out = buildNamedCustomFields(
        [
          { id: 'cf_1', value: 'Juan' },
          { id: 'cf_2', value: 'Premium' },
          { id: 'cf_unknown', value: 'ignored' },
        ],
        defs,
      );

      expect(out).toEqual([
        { id: 'cf_1', name: 'Nombre Cliente', value: 'Juan' },
        { id: 'cf_2', name: 'Plan', value: 'Premium' },
      ]);
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

      expect(out).toEqual([
        { id: 'cf_1', name: 'Nombre Cliente', value: 'Juan' },
        { id: 'cf_3', name: 'Edad', value: '30' },
        { id: 'cf_4', name: 'Activo', value: 'true' },
        { id: 'cf_5', name: 'Intereses', value: 'rock, jazz' },
      ]);
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

      expect(out).toEqual([]);
    });

    it('keeps duplicate names as separate entries, each with its own id', () => {
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

      expect(out).toEqual([
        { id: 'cf_1', name: 'Plan', value: 'Basic' },
        { id: 'cf_2', name: 'Plan', value: 'Premium' },
      ]);
    });
  });
});
