import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { InsistenceClient, ScheduleInput } from './insistence-client';
import { AppEnv } from '../config/env.validation';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeClient() {
  const post = jest.fn();
  const del = jest.fn();
  mockedAxios.create.mockReturnValue({
    post,
    delete: del,
  } as unknown as ReturnType<typeof axios.create>);

  const env: Record<string, string | number> = {
    JOBS_URL: 'https://jobs.example.com',
    JOBS_API_TIMEOUT_MS: 4000,
  };
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService<AppEnv, true>;

  return { client: new InsistenceClient(config), post, del };
}

const baseInput: ScheduleInput = {
  jobId: 'job-1',
  locationId: 'loc_abc',
  contactId: 'contact_123',
  agentId: 'agent_xyz',
  apiKey: 'sk_xxx',
  replyChannel: 'WhatsApp',
  insistences: [
    { hours: 0, minutes: 10 },
    { hours: 1, minutes: 0 },
  ],
};

describe('InsistenceClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('configures the jobs axios client with baseURL and timeout', () => {
      makeClient();
      expect(mockedAxios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://jobs.example.com',
          timeout: 4000,
        }),
      );
    });
  });

  describe('schedule', () => {
    it('POSTs the mapped times and full payload to /insistence', async () => {
      const { client, post } = makeClient();
      post.mockResolvedValue({ status: 202, data: { ok: true } });

      await client.schedule(baseInput);

      expect(post).toHaveBeenCalledTimes(1);
      const [url, body] = post.mock.calls[0];
      expect(url).toBe('/insistence');
      expect(body).toEqual({
        times: [10, 60],
        locationId: 'loc_abc',
        contactId: 'contact_123',
        agentId: 'agent_xyz',
        apiKey: 'sk_xxx',
        replyChannel: 'WhatsApp',
      });
    });

    it('skips when insistences is undefined', async () => {
      const { client, post } = makeClient();

      await client.schedule({ ...baseInput, insistences: undefined });

      expect(post).not.toHaveBeenCalled();
    });

    it('skips when insistences is an empty array', async () => {
      const { client, post } = makeClient();

      await client.schedule({ ...baseInput, insistences: [] });

      expect(post).not.toHaveBeenCalled();
    });

    it('drops entries that map to non-positive minutes', async () => {
      const { client, post } = makeClient();
      post.mockResolvedValue({ status: 200, data: {} });

      await client.schedule({
        ...baseInput,
        insistences: [
          { hours: 0, minutes: 0 },
          { hours: 0, minutes: 10 },
          { hours: 'NaN' as unknown as number, minutes: 5 },
          { hours: 2, minutes: 30 },
        ],
      });

      const [, body] = post.mock.calls[0];
      expect(body.times).toEqual([10, 150]);
    });

    it('skips POST when all entries collapse to non-positive minutes', async () => {
      const { client, post } = makeClient();

      await client.schedule({
        ...baseInput,
        insistences: [{ hours: 0, minutes: 0 }],
      });

      expect(post).not.toHaveBeenCalled();
    });

    it('swallows non-2xx responses without throwing', async () => {
      const { client, post } = makeClient();
      post.mockResolvedValue({ status: 500, data: 'jobs down' });

      await expect(client.schedule(baseInput)).resolves.toBeUndefined();
    });

    it('swallows transport errors without throwing', async () => {
      const { client, post } = makeClient();
      const err = new Error('timeout') as AxiosError;
      err.code = 'ETIMEDOUT';
      post.mockRejectedValue(err);

      await expect(client.schedule(baseInput)).resolves.toBeUndefined();
    });

    it('forwards the IG replyChannel through to the POST body', async () => {
      const { client, post } = makeClient();
      post.mockResolvedValue({ status: 200, data: {} });

      await client.schedule({ ...baseInput, replyChannel: 'IG' });

      const [, body] = post.mock.calls[0];
      expect(body.replyChannel).toBe('IG');
    });
  });

  describe('cancel', () => {
    it('DELETEs /insistence/:contactId on 2xx and resolves', async () => {
      const { client, del } = makeClient();
      del.mockResolvedValue({ status: 204, data: '' });

      await expect(
        client.cancel({ jobId: 'job-1', contactId: 'contact_123' }),
      ).resolves.toBeUndefined();

      expect(del).toHaveBeenCalledWith('/insistence/contact_123');
    });

    it('encodes special characters in the contactId path segment', async () => {
      const { client, del } = makeClient();
      del.mockResolvedValue({ status: 200, data: {} });

      await client.cancel({ jobId: 'job-1', contactId: 'c/with space' });

      expect(del).toHaveBeenCalledWith('/insistence/c%2Fwith%20space');
    });

    it('treats 404 as a normal "nothing to cancel" outcome and does not throw', async () => {
      const { client, del } = makeClient();
      del.mockResolvedValue({ status: 404, data: { error: 'not found' } });

      await expect(
        client.cancel({ jobId: 'job-1', contactId: 'contact_123' }),
      ).resolves.toBeUndefined();
    });

    it('swallows other non-2xx responses without throwing', async () => {
      const { client, del } = makeClient();
      del.mockResolvedValue({ status: 500, data: 'jobs down' });

      await expect(
        client.cancel({ jobId: 'job-1', contactId: 'contact_123' }),
      ).resolves.toBeUndefined();
    });

    it('swallows 4xx (other than 404) without throwing', async () => {
      const { client, del } = makeClient();
      del.mockResolvedValue({ status: 400, data: 'bad request' });

      await expect(
        client.cancel({ jobId: 'job-1', contactId: 'contact_123' }),
      ).resolves.toBeUndefined();
    });

    it('swallows transport errors without throwing', async () => {
      const { client, del } = makeClient();
      const err = new Error('connect ECONNREFUSED') as AxiosError;
      err.code = 'ECONNREFUSED';
      del.mockRejectedValue(err);

      await expect(
        client.cancel({ jobId: 'job-1', contactId: 'contact_123' }),
      ).resolves.toBeUndefined();
    });
  });
});
