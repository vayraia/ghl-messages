import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { GroupFetcher } from './group-fetcher';
import { AppEnv } from '../config/env.validation';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeFetcher() {
  const get = jest.fn();
  mockedAxios.create.mockReturnValue({ get } as unknown as ReturnType<typeof axios.create>);

  const env: Record<string, string | number> = {
    CHAT_API_URL: 'https://chat.example.com',
    CHAT_API_TIMEOUT_MS: 5000,
  };
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService<AppEnv, true>;

  return { fetcher: new GroupFetcher(config), get };
}

describe('GroupFetcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('configures axios with the chat baseURL and timeout', () => {
    makeFetcher();
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://chat.example.com',
        timeout: 5000,
      }),
    );
  });

  it('GETs /groups/by-location/{id} and returns apiKey + insistences', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({
      status: 200,
      data: {
        api_key: 'sk_xxx',
        general_settings: {
          insistences: [
            { hours: 0, minutes: 10 },
            { hours: 1, minutes: 0 },
          ],
        },
      },
    });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(get).toHaveBeenCalledWith('/groups/by-location/loc_abc');
    expect(result).toEqual({
      apiKey: 'sk_xxx',
      insistences: [
        { hours: 0, minutes: 10 },
        { hours: 1, minutes: 0 },
      ],
    });
  });

  it('encodes special characters in the locationId path segment', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({ status: 200, data: { api_key: 'k' } });

    await fetcher.fetch('loc/with spaces', 'job-1');

    expect(get).toHaveBeenCalledWith('/groups/by-location/loc%2Fwith%20spaces');
  });

  it('returns insistences=undefined when general_settings is missing', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({ status: 200, data: { api_key: 'sk' } });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(result).toEqual({ apiKey: 'sk', insistences: undefined, aiFieldId: undefined });
  });

  it('exposes aiFieldId when general_settings.ai_field_id has id and key', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({
      status: 200,
      data: {
        api_key: 'sk',
        general_settings: {
          ai_field_id: { id: 'cf_1', key: 'ai_status' },
        },
      },
    });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(result.aiFieldId).toEqual({ id: 'cf_1', key: 'ai_status' });
  });

  it('returns aiFieldId=undefined when ai_field_id is partially populated', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({
      status: 200,
      data: {
        api_key: 'sk',
        general_settings: { ai_field_id: { id: 'cf_1' } },
      },
    });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(result.aiFieldId).toBeUndefined();
  });

  it('returns aiFieldId=undefined when ai_field_id has blank strings', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({
      status: 200,
      data: {
        api_key: 'sk',
        general_settings: { ai_field_id: { id: '   ', key: '' } },
      },
    });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(result.aiFieldId).toBeUndefined();
  });

  it('throws UnrecoverableError when 2xx response has no api_key', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({
      status: 200,
      data: { general_settings: { insistences: [] } },
    });

    await expect(fetcher.fetch('loc_abc', 'job-1')).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError when api_key is blank', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({ status: 200, data: { api_key: '   ' } });

    await expect(fetcher.fetch('loc_abc', 'job-1')).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError when 2xx body is not an object', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({ status: 200, data: 'not json' });

    await expect(fetcher.fetch('loc_abc', 'job-1')).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnrecoverableError on 4xx', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({ status: 404, data: { error: 'not found' } });

    await expect(fetcher.fetch('loc_abc', 'job-1')).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('throws a regular Error on 5xx (retryable)', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({ status: 503, data: 'service down' });

    const err = await fetcher.fetch('loc_abc', 'job-1').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(err.message).toMatch(/503/);
  });

  it('throws a regular Error on transport failure (retryable)', async () => {
    const { fetcher, get } = makeFetcher();
    const transportErr = new Error('connect ECONNREFUSED') as AxiosError;
    transportErr.code = 'ECONNREFUSED';
    get.mockRejectedValue(transportErr);

    const err = await fetcher.fetch('loc_abc', 'job-1').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(err.message).toMatch(/ECONNREFUSED/);
  });
});
