import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { TemplateFollowupsClient } from './template-followups-client';
import { AppEnv } from '../config/env.validation';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeClient(env: Record<string, string | number | undefined> = {}) {
  const del = jest.fn();
  mockedAxios.create.mockReturnValue({
    delete: del,
  } as unknown as ReturnType<typeof axios.create>);

  const merged: Record<string, string | number | undefined> = {
    JOBS_URL: 'https://jobs.example.com',
    JOBS_API_TIMEOUT_MS: 4000,
    ...env,
  };
  const config = {
    get: (key: string) => merged[key],
  } as unknown as ConfigService<AppEnv, true>;

  return { client: new TemplateFollowupsClient(config), del };
}

const input = { contactId: 'contact_123', locationId: 'loc_abc' };

describe('TemplateFollowupsClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('configures the jobs axios client with baseURL and timeout', () => {
    makeClient();
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://jobs.example.com', timeout: 4000 }),
    );
  });

  it('DELETEs /template-followups/:contactId with locationId as query param', async () => {
    const { client, del } = makeClient();
    del.mockResolvedValue({ status: 200, data: { cancelled: 2 } });

    await client.cancel(input);

    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith('/template-followups/contact_123', {
      params: { locationId: 'loc_abc' },
    });
  });

  it('url-encodes the contactId path segment', async () => {
    const { client, del } = makeClient();
    del.mockResolvedValue({ status: 200, data: { cancelled: 0 } });

    await client.cancel({ ...input, contactId: 'a/b c' });

    expect(del.mock.calls[0][0]).toBe('/template-followups/a%2Fb%20c');
  });

  it('does nothing when JOBS_URL is unset', async () => {
    const { client, del } = makeClient({ JOBS_URL: undefined });

    await expect(client.cancel(input)).resolves.toBeUndefined();

    expect(mockedAxios.create).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('swallows transport errors', async () => {
    const { client, del } = makeClient();
    del.mockRejectedValue(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }));

    await expect(client.cancel(input)).resolves.toBeUndefined();
  });

  it('swallows non-2xx responses', async () => {
    const { client, del } = makeClient();
    del.mockResolvedValue({ status: 500, data: { error: 'x' } });

    await expect(client.cancel(input)).resolves.toBeUndefined();
  });

  it('treats 404 as normal', async () => {
    const { client, del } = makeClient();
    del.mockResolvedValue({ status: 404, data: {} });

    await expect(client.cancel(input)).resolves.toBeUndefined();
  });
});
