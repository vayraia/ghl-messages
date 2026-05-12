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
      insistenceSchedule: undefined,
      aiFieldId: undefined,
      nonBlockingUsers: undefined,
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

    expect(result).toEqual({
      apiKey: 'sk',
      insistences: undefined,
      insistenceSchedule: undefined,
      aiFieldId: undefined,
      nonBlockingUsers: undefined,
    });
  });

  it('passes through insistence_schedule as-is when it is an object', async () => {
    const { fetcher, get } = makeFetcher();
    const schedule = {
      monday: { active: true, start: '09:00', end: '18:00' },
      tuesday: { active: true, start: '09:00', end: '18:00' },
      wednesday: { active: true, start: '09:00', end: '18:00' },
      thursday: { active: true, start: '09:00', end: '18:00' },
      friday: { active: true, start: '09:00', end: '18:00' },
      saturday: { active: false, start: '09:00', end: '13:00' },
      sunday: { active: false, start: '09:00', end: '13:00' },
    };
    get.mockResolvedValue({
      status: 200,
      data: { api_key: 'sk', general_settings: { insistence_schedule: schedule } },
    });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(result.insistenceSchedule).toEqual(schedule);
  });

  it('returns insistenceSchedule=undefined when insistence_schedule is not an object', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({
      status: 200,
      data: { api_key: 'sk', general_settings: { insistence_schedule: 'monday-friday' } },
    });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(result.insistenceSchedule).toBeUndefined();
  });

  it('returns insistenceSchedule=undefined when insistence_schedule is an array', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({
      status: 200,
      data: { api_key: 'sk', general_settings: { insistence_schedule: [] } },
    });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(result.insistenceSchedule).toBeUndefined();
  });

  it('returns insistenceSchedule=undefined when insistence_schedule is null', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({
      status: 200,
      data: { api_key: 'sk', general_settings: { insistence_schedule: null } },
    });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(result.insistenceSchedule).toBeUndefined();
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

  it('parses non_blocking_users when entries have id and name', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({
      status: 200,
      data: {
        api_key: 'sk',
        general_settings: {
          non_blocking_users: [
            { id: 'u_admin', name: 'Admin' },
            { id: 'u_owner', name: 'Owner' },
          ],
        },
      },
    });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(result.nonBlockingUsers).toEqual([
      { id: 'u_admin', name: 'Admin' },
      { id: 'u_owner', name: 'Owner' },
    ]);
  });

  it('returns nonBlockingUsers=undefined when the field is missing', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({
      status: 200,
      data: { api_key: 'sk', general_settings: {} },
    });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(result.nonBlockingUsers).toBeUndefined();
  });

  it('returns nonBlockingUsers=undefined for an empty array', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({
      status: 200,
      data: {
        api_key: 'sk',
        general_settings: { non_blocking_users: [] },
      },
    });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(result.nonBlockingUsers).toBeUndefined();
  });

  it('returns nonBlockingUsers=undefined when the field is not an array', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({
      status: 200,
      data: {
        api_key: 'sk',
        general_settings: { non_blocking_users: { id: 'u' } },
      },
    });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(result.nonBlockingUsers).toBeUndefined();
  });

  it('drops non_blocking_users entries with missing or blank id', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({
      status: 200,
      data: {
        api_key: 'sk',
        general_settings: {
          non_blocking_users: [
            { id: 'u_keep', name: 'Keep' },
            { id: '   ', name: 'Blank' },
            { name: 'No ID' },
            { id: 42, name: 'Wrong type' },
            null,
            'string-entry',
            { id: 'u_keep2', name: 'Also Keep' },
          ],
        },
      },
    });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(result.nonBlockingUsers).toEqual([
      { id: 'u_keep', name: 'Keep' },
      { id: 'u_keep2', name: 'Also Keep' },
    ]);
  });

  it('normalizes missing or non-string name to empty string when id is valid', async () => {
    const { fetcher, get } = makeFetcher();
    get.mockResolvedValue({
      status: 200,
      data: {
        api_key: 'sk',
        general_settings: {
          non_blocking_users: [
            { id: 'u_1' },
            { id: 'u_2', name: 99 },
            { id: 'u_3', name: '  Trimmed  ' },
          ],
        },
      },
    });

    const result = await fetcher.fetch('loc_abc', 'job-1');

    expect(result.nonBlockingUsers).toEqual([
      { id: 'u_1', name: '' },
      { id: 'u_2', name: '' },
      { id: 'u_3', name: 'Trimmed' },
    ]);
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
