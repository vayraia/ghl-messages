import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookSecretGuard } from './guards/webhook-secret.guard';

function fakeReq(body: unknown): Request {
  return { body } as unknown as Request;
}

describe('WebhookController', () => {
  const serviceMock = { ingest: jest.fn() };

  let controller: WebhookController;

  beforeEach(async () => {
    serviceMock.ingest.mockReset();
    const moduleRef = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [{ provide: WebhookService, useValue: serviceMock }],
    })
      .overrideGuard(WebhookSecretGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(WebhookController);
  });

  it('forwards the payload, idempotency key and request id to the service', async () => {
    serviceMock.ingest.mockResolvedValue({
      jobId: 'flush-1',
      deduplicated: false,
      debounced: false,
      pendingCount: 1,
    });

    const payload = { agent_id: 'ventas', contact_id: 'c-1', message: { body: 'hi' } };
    const response = await controller.ingest(
      fakeReq(payload),
      payload,
      'idem-1',
      'req-1',
    );

    expect(response).toEqual({
      accepted: true,
      jobId: 'flush-1',
      deduplicated: false,
      debounced: false,
    });
    expect(serviceMock.ingest).toHaveBeenCalledWith(
      { agent_id: 'ventas', contact_id: 'c-1', message: { body: 'hi' } },
      { idempotencyKey: 'idem-1', requestId: 'req-1' },
    );
  });

  it('reports deduplication back to the caller', async () => {
    serviceMock.ingest.mockResolvedValue({
      jobId: 'idem-2',
      deduplicated: true,
      debounced: false,
      pendingCount: 0,
    });

    const payload = { agent_id: 'ventas', contact_id: 'c-1' };
    const response = await controller.ingest(
      fakeReq(payload),
      payload,
      'idem-2',
      undefined,
    );

    expect(response).toEqual({
      accepted: true,
      jobId: 'idem-2',
      deduplicated: true,
      debounced: false,
    });
  });

  it('reports debounced when the service coalesced multiple messages', async () => {
    serviceMock.ingest.mockResolvedValue({
      jobId: 'flush-2',
      deduplicated: false,
      debounced: true,
      pendingCount: 3,
    });

    const payload = { agent_id: 'ventas', contact_id: 'c-1', message: { body: '3rd' } };
    const response = await controller.ingest(
      fakeReq(payload),
      payload,
      undefined,
      undefined,
    );

    expect(response.debounced).toBe(true);
  });
});
