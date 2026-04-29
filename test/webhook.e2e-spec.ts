import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { WEBHOOK_QUEUE_TOKEN, WEBHOOK_REDIS_CLIENT } from '../src/webhook/webhook.tokens';
import { WebhookProcessor } from '../src/webhook/webhook.processor';
import {
  WEBHOOK_IDEMPOTENCY_HEADER,
  WEBHOOK_SECRET_HEADER,
} from '../src/webhook/webhook.constants';

const SECRET = 'e2e-test-secret-value-please-be-long-enough';

describe('Webhook (e2e)', () => {
  let app: INestApplication;

  const queueMock = {
    add: jest.fn(),
    getJob: jest.fn(),
  };

  // Minimal in-memory Redis stub matching the calls the service & debouncer
  // make. We simulate SET NX (idempotency) and the multi() pipeline used by
  // the debouncer's RPUSH+EXPIRE.
  const idemStore = new Map<string, string>();
  const redisStub = {
    set: jest.fn(async (key: string, value: string, _ex?: string, _ttl?: number, mode?: string) => {
      if (mode === 'NX') {
        if (idemStore.has(key)) return null;
        idemStore.set(key, value);
        return 'OK';
      }
      idemStore.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async () => null),
    multi: jest.fn(() => {
      const tx = {
        rpush: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        lrange: jest.fn().mockReturnThis(),
        del: jest.fn().mockReturnThis(),
        exec: jest.fn(async () => [
          [null, 1],
          [null, 1],
        ]),
      };
      return tx;
    }),
    quit: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(getQueueToken(WEBHOOK_QUEUE_TOKEN))
      .useValue(queueMock)
      .overrideProvider(WEBHOOK_REDIS_CLIENT)
      .useValue(redisStub)
      .overrideProvider(WebhookProcessor)
      .useValue({ onApplicationBootstrap: () => undefined })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    queueMock.add.mockReset();
    queueMock.getJob.mockReset();
    idemStore.clear();
  });

  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      agent_id: 'ventas',
      contact_id: 'c-1',
      message: { body: 'hola' },
      ...overrides,
    };
  }

  it('rejects requests with no secret header (401)', async () => {
    await request(app.getHttpServer()).post('/v1/webhook').send(validBody()).expect(401);

    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it('rejects requests with the wrong secret (401)', async () => {
    await request(app.getHttpServer())
      .post('/v1/webhook')
      .set(WEBHOOK_SECRET_HEADER, 'wrong-secret')
      .send(validBody())
      .expect(401);

    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it('accepts a valid request, schedules a debounced flush, and returns 202', async () => {
    queueMock.getJob.mockResolvedValue(undefined);
    queueMock.add.mockResolvedValue({ id: 'flush_ventas_c-1_t1' });

    const res = await request(app.getHttpServer())
      .post('/v1/webhook')
      .set(WEBHOOK_SECRET_HEADER, SECRET)
      .send(validBody())
      .expect(202);

    expect(res.body).toMatchObject({
      accepted: true,
      deduplicated: false,
      debounced: false,
    });
    expect(typeof res.body.jobId).toBe('string');
    expect(queueMock.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queueMock.add.mock.calls[0];
    expect(name).toBe('webhook.flush');
    expect(data).toEqual({ agentId: 'ventas', contactId: 'c-1' });
    expect(opts.delay).toBeGreaterThanOrEqual(0);
  });

  it('honours x-idempotency-key by deduplicating', async () => {
    queueMock.add.mockResolvedValue({ id: 'flush-1' });

    // First delivery → fresh
    await request(app.getHttpServer())
      .post('/v1/webhook')
      .set(WEBHOOK_SECRET_HEADER, SECRET)
      .set(WEBHOOK_IDEMPOTENCY_HEADER, 'evt-1')
      .send(validBody())
      .expect(202);

    queueMock.add.mockClear();

    // Second delivery with same key → dedup
    const res = await request(app.getHttpServer())
      .post('/v1/webhook')
      .set(WEBHOOK_SECRET_HEADER, SECRET)
      .set(WEBHOOK_IDEMPOTENCY_HEADER, 'evt-1')
      .send(validBody())
      .expect(202);

    expect(res.body).toEqual({
      accepted: true,
      jobId: 'evt-1',
      deduplicated: true,
      debounced: false,
    });
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it('rejects payloads missing both top-level and customData agent_id (400)', async () => {
    await request(app.getHttpServer())
      .post('/v1/webhook')
      .set(WEBHOOK_SECRET_HEADER, SECRET)
      .send({ contact_id: 'c-1', message: { body: 'hi' } })
      .expect(400);
  });

  it('falls back to customData.agent_id when top-level is missing', async () => {
    queueMock.add.mockResolvedValue({ id: 'flush-fb' });

    await request(app.getHttpServer())
      .post('/v1/webhook')
      .set(WEBHOOK_SECRET_HEADER, SECRET)
      .send({
        contact_id: 'c-1',
        message: { body: 'hola' },
        customData: { agent_id: 'ventas-from-custom' },
      })
      .expect(202);

    expect(queueMock.add).toHaveBeenCalledTimes(1);
    const [, data] = queueMock.add.mock.calls[0];
    expect(data).toEqual({ agentId: 'ventas-from-custom', contactId: 'c-1' });
  });

  it('silently strips unknown top-level fields and accepts the request', async () => {
    queueMock.add.mockResolvedValue({ id: 'flush-strip' });

    await request(app.getHttpServer())
      .post('/v1/webhook')
      .set(WEBHOOK_SECRET_HEADER, SECRET)
      .send({
        ...validBody(),
        first_name: 'Fabio',
        phone: '+51930265817',
        location: { id: 'loc-1' },
        workflow: { id: 'wf-1' },
      })
      .expect(202);
  });

  it('echoes a request id in the response headers', async () => {
    queueMock.add.mockResolvedValue({ id: 'flush-rid' });

    const res = await request(app.getHttpServer())
      .post('/v1/webhook')
      .set(WEBHOOK_SECRET_HEADER, SECRET)
      .send(validBody())
      .expect(202);

    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
