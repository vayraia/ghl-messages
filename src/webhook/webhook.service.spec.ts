import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookService } from './webhook.service';
import { MessageDebouncer } from './message-debouncer';
import { WEBHOOK_REDIS_CLIENT } from './webhook.tokens';
import { WebhookPayloadDto } from './dto/webhook-payload.dto';

describe('WebhookService', () => {
  const debouncerMock = { accept: jest.fn() };
  const redisMock = { set: jest.fn() };

  let service: WebhookService;

  beforeEach(async () => {
    debouncerMock.accept.mockReset();
    redisMock.set.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        WebhookService,
        { provide: MessageDebouncer, useValue: debouncerMock },
        { provide: WEBHOOK_REDIS_CLIENT, useValue: redisMock },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'IDEMPOTENCY_TTL_SECONDS') return 3600;
              return undefined;
            },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(WebhookService);
  });

  function basePayload(overrides: Partial<WebhookPayloadDto> = {}): WebhookPayloadDto {
    return {
      agent_id: 'ventas',
      contact_id: 'c-1',
      message: { body: 'hola' },
      ...overrides,
    } as WebhookPayloadDto;
  }

  it('debounces a fresh inbound message', async () => {
    debouncerMock.accept.mockResolvedValue({ jobId: 'flush-1', pendingCount: 1 });

    const result = await service.ingest(basePayload(), { requestId: 'req-1' });

    expect(debouncerMock.accept).toHaveBeenCalledWith({
      agentId: 'ventas',
      contactId: 'c-1',
      body: 'hola',
      replyChannel: 'WhatsApp',
      requestId: 'req-1',
    });
    expect(result).toEqual({
      jobId: 'flush-1',
      deduplicated: false,
      debounced: false,
      pendingCount: 1,
    });
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('marks debounced=true when more than one message was pending', async () => {
    debouncerMock.accept.mockResolvedValue({ jobId: 'flush-2', pendingCount: 3 });

    const result = await service.ingest(basePayload({ message: { body: '3rd' } }), {});

    expect(result.debounced).toBe(true);
    expect(result.pendingCount).toBe(3);
  });

  it('falls back to customData.message when message.body is missing', async () => {
    debouncerMock.accept.mockResolvedValue({ jobId: 'flush-3', pendingCount: 1 });

    await service.ingest(
      basePayload({ message: undefined, customData: { message: 'desde GHL' } }),
      {},
    );

    expect(debouncerMock.accept).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'desde GHL' }),
    );
  });

  it('silently acknowledges empty messages without enqueuing', async () => {
    const result = await service.ingest(basePayload({ message: { body: '   ' } }), {});

    expect(result).toEqual({
      jobId: '',
      deduplicated: false,
      debounced: false,
      pendingCount: 0,
    });
    expect(debouncerMock.accept).not.toHaveBeenCalled();
  });

  it('uses Redis SETNX to dedup on idempotency-key', async () => {
    redisMock.set.mockResolvedValue('OK');
    debouncerMock.accept.mockResolvedValue({ jobId: 'flush-4', pendingCount: 1 });

    const result = await service.ingest(basePayload(), { idempotencyKey: 'evt-1' });

    expect(redisMock.set).toHaveBeenCalledWith('webhook:idem:evt-1', '1', 'EX', 3600, 'NX');
    expect(debouncerMock.accept).toHaveBeenCalled();
    expect(result.deduplicated).toBe(false);
  });

  it('returns deduplicated=true and skips debounce when idempotency-key already seen', async () => {
    redisMock.set.mockResolvedValue(null);

    const result = await service.ingest(basePayload(), { idempotencyKey: 'evt-1' });

    expect(result).toEqual({
      jobId: 'evt-1',
      deduplicated: true,
      debounced: false,
      pendingCount: 0,
    });
    expect(debouncerMock.accept).not.toHaveBeenCalled();
  });

  it('falls back to customData.agent_id when top-level is missing', async () => {
    debouncerMock.accept.mockResolvedValue({ jobId: 'flush-cd', pendingCount: 1 });

    await service.ingest(
      basePayload({ agent_id: undefined, customData: { agent_id: 'from-custom' } }),
      {},
    );

    expect(debouncerMock.accept).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'from-custom' }),
    );
  });

  it('throws BadRequest when both agent_id sources are missing', async () => {
    await expect(service.ingest(basePayload({ agent_id: undefined }), {})).rejects.toThrow(
      'agent_id is required',
    );
    expect(debouncerMock.accept).not.toHaveBeenCalled();
  });

  it('passes the resolved replyChannel from contact attribution', async () => {
    debouncerMock.accept.mockResolvedValue({ jobId: 'flush-5', pendingCount: 1 });

    await service.ingest(
      basePayload({ contact: { lastAttributionSource: { medium: 'instagram' } } }),
      {},
    );

    expect(debouncerMock.accept).toHaveBeenCalledWith(
      expect.objectContaining({ replyChannel: 'IG' }),
    );
  });

  describe('contactName resolution', () => {
    beforeEach(() => {
      debouncerMock.accept.mockResolvedValue({ jobId: 'flush-name', pendingCount: 1 });
    });

    it('uses top-level name when present', async () => {
      await service.ingest(basePayload({ name: 'Fabio Coronado' }), {});
      expect(debouncerMock.accept).toHaveBeenCalledWith(
        expect.objectContaining({ contactName: 'Fabio Coronado' }),
      );
    });

    it('falls back to full_name when name is missing', async () => {
      await service.ingest(basePayload({ full_name: 'Fabio Coronado' }), {});
      expect(debouncerMock.accept).toHaveBeenCalledWith(
        expect.objectContaining({ contactName: 'Fabio Coronado' }),
      );
    });

    it('falls back to first_name + last_name when name and full_name are missing', async () => {
      await service.ingest(basePayload({ first_name: 'Fabio', last_name: 'Coronado' }), {});
      expect(debouncerMock.accept).toHaveBeenCalledWith(
        expect.objectContaining({ contactName: 'Fabio Coronado' }),
      );
    });

    it('uses only first_name when last_name is missing', async () => {
      await service.ingest(basePayload({ first_name: 'Fabio' }), {});
      expect(debouncerMock.accept).toHaveBeenCalledWith(
        expect.objectContaining({ contactName: 'Fabio' }),
      );
    });

    it('uses only last_name when first_name is missing', async () => {
      await service.ingest(basePayload({ last_name: 'Coronado' }), {});
      expect(debouncerMock.accept).toHaveBeenCalledWith(
        expect.objectContaining({ contactName: 'Coronado' }),
      );
    });

    it('honours the preference order name > full_name > first/last', async () => {
      await service.ingest(
        basePayload({
          name: 'PRIMARY',
          full_name: 'SECONDARY',
          first_name: 'Third',
          last_name: 'Tier',
        }),
        {},
      );
      expect(debouncerMock.accept).toHaveBeenCalledWith(
        expect.objectContaining({ contactName: 'PRIMARY' }),
      );
    });

    it('trims whitespace and treats blank-only sources as missing', async () => {
      await service.ingest(basePayload({ name: '   ', full_name: '  Fabio  ' }), {});
      expect(debouncerMock.accept).toHaveBeenCalledWith(
        expect.objectContaining({ contactName: 'Fabio' }),
      );
    });

    it('omits contactName when no source is present', async () => {
      await service.ingest(basePayload(), {});
      const callArg = debouncerMock.accept.mock.calls[0][0];
      expect(callArg.contactName).toBeUndefined();
    });
  });
});
