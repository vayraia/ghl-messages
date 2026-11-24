import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Job, UnrecoverableError } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { AiBillingProcessor } from './ai-billing.processor';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function make() {
  const post = jest.fn();
  mockedAxios.create.mockReturnValue({ post } as unknown as ReturnType<typeof axios.create>);
  const env: Record<string, unknown> = {
    CHAT_API_URL: 'http://ai.internal',
    CHAT_API_TIMEOUT_MS: 5000,
    AI_SERVICE_API_KEY: ' svc-key ',
    PROCESS_JOBS: true,
  };
  const config = { get: (k: string) => env[k] } as unknown as ConfigService<AppEnv, true>;
  return { processor: new AiBillingProcessor(config), post };
}

const job = {
  data: {
    locationId: 'loc_1',
    contactId: 'c_1',
    jobId: 'flush_1',
    occurredAt: '2026-11-24T10:00:00.000Z',
  },
} as unknown as Job<never>;

describe('AiBillingProcessor', () => {
  beforeEach(() => jest.clearAllMocks());

  it('builds the client against CHAT_API_URL with the trimmed service key and no redirects', () => {
    make();
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://ai.internal',
        timeout: 5000,
        maxRedirects: 0,
        headers: expect.objectContaining({ 'X-API-Key': 'svc-key' }),
      }),
    );
  });

  it('posts the event in snake_case to /billing/ai-contacts/register', async () => {
    const { processor, post } = make();
    post.mockResolvedValue({ status: 200, data: { status: 'free' } });
    await expect(processor.process(job as never)).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledWith('/billing/ai-contacts/register', {
      location_id: 'loc_1',
      contact_id: 'c_1',
      job_id: 'flush_1',
      occurred_at: '2026-11-24T10:00:00.000Z',
    });
  });

  it.each([400, 401, 403, 404, 422])('does not retry a %i (misconfiguration)', async (status) => {
    const { processor, post } = make();
    post.mockResolvedValue({ status, data: {} });
    await expect(processor.process(job as never)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it.each([429, 500, 502, 503])('retries a %i', async (status) => {
    const { processor, post } = make();
    post.mockResolvedValue({ status, data: {} });
    const err = await processor.process(job as never).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it('retries on a transport error without leaking the service key in the message', async () => {
    const { processor, post } = make();
    post.mockRejectedValue(new Error('ECONNREFUSED'));
    const err = (await processor.process(job as never).catch((e) => e)) as Error;
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(err.message).not.toContain('svc-key');
  });
});
