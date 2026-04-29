import { Test } from '@nestjs/testing';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookSecretGuard } from './guards/webhook-secret.guard';

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

    const response = await controller.ingest(
      { agent_id: 'ventas', contact_id: 'c-1', message: { body: 'hi' } },
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

    const response = await controller.ingest(
      { agent_id: 'ventas', contact_id: 'c-1' },
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

    const response = await controller.ingest(
      { agent_id: 'ventas', contact_id: 'c-1', message: { body: '3rd' } },
      undefined,
      undefined,
    );

    expect(response.debounced).toBe(true);
  });
});
