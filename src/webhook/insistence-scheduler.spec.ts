import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { InsistenceScheduler, ScheduleInput } from './insistence-scheduler';
import { AppEnv } from '../config/env.validation';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeScheduler() {
  const post = jest.fn();
  mockedAxios.create.mockReturnValue({ post } as unknown as ReturnType<typeof axios.create>);

  const env: Record<string, string | number> = {
    JOBS_URL: 'https://jobs.example.com',
    JOBS_API_TIMEOUT_MS: 4000,
  };
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService<AppEnv, true>;

  return { scheduler: new InsistenceScheduler(config), post };
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

describe('InsistenceScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('configures the jobs axios client with baseURL and timeout', () => {
    makeScheduler();
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://jobs.example.com',
        timeout: 4000,
      }),
    );
  });

  it('POSTs the mapped times and full payload to /insistence', async () => {
    const { scheduler, post } = makeScheduler();
    post.mockResolvedValue({ status: 202, data: { ok: true } });

    await scheduler.schedule(baseInput);

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
    const { scheduler, post } = makeScheduler();

    await scheduler.schedule({ ...baseInput, insistences: undefined });

    expect(post).not.toHaveBeenCalled();
  });

  it('skips when insistences is an empty array', async () => {
    const { scheduler, post } = makeScheduler();

    await scheduler.schedule({ ...baseInput, insistences: [] });

    expect(post).not.toHaveBeenCalled();
  });

  it('drops entries that map to non-positive minutes', async () => {
    const { scheduler, post } = makeScheduler();
    post.mockResolvedValue({ status: 200, data: {} });

    await scheduler.schedule({
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
    const { scheduler, post } = makeScheduler();

    await scheduler.schedule({
      ...baseInput,
      insistences: [{ hours: 0, minutes: 0 }],
    });

    expect(post).not.toHaveBeenCalled();
  });

  it('swallows non-2xx responses without throwing', async () => {
    const { scheduler, post } = makeScheduler();
    post.mockResolvedValue({ status: 500, data: 'jobs down' });

    await expect(scheduler.schedule(baseInput)).resolves.toBeUndefined();
  });

  it('swallows transport errors without throwing', async () => {
    const { scheduler, post } = makeScheduler();
    const err = new Error('timeout') as AxiosError;
    err.code = 'ETIMEDOUT';
    post.mockRejectedValue(err);

    await expect(scheduler.schedule(baseInput)).resolves.toBeUndefined();
  });

  it('forwards the IG replyChannel through to the POST body', async () => {
    const { scheduler, post } = makeScheduler();
    post.mockResolvedValue({ status: 200, data: {} });

    await scheduler.schedule({ ...baseInput, replyChannel: 'IG' });

    const [, body] = post.mock.calls[0];
    expect(body.replyChannel).toBe('IG');
  });
});
