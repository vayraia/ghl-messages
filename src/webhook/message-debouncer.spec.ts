import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { MessageDebouncer } from './message-debouncer';
import { WEBHOOK_FLUSH_JOB, WEBHOOK_QUEUE_TOKEN, WEBHOOK_REDIS_CLIENT } from './webhook.tokens';

describe('MessageDebouncer', () => {
  let debouncer: MessageDebouncer;

  const queueMock = {
    add: jest.fn(),
    getJob: jest.fn(),
  };

  const txExec = jest.fn();
  const tx = {
    rpush: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    lrange: jest.fn().mockReturnThis(),
    del: jest.fn().mockReturnThis(),
    exec: txExec,
  };

  const redisMock = {
    multi: jest.fn(() => tx),
    get: jest.fn(),
    set: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    txExec.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [
        MessageDebouncer,
        { provide: getQueueToken(WEBHOOK_QUEUE_TOKEN), useValue: queueMock },
        { provide: WEBHOOK_REDIS_CLIENT, useValue: redisMock },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'MESSAGE_DEBOUNCE_MS') return 10_000;
              if (key === 'WEBHOOK_JOB_ATTEMPTS') return 3;
              if (key === 'WEBHOOK_JOB_BACKOFF_MS') return 1000;
              return undefined;
            },
          },
        },
      ],
    }).compile();

    debouncer = moduleRef.get(MessageDebouncer);
  });

  describe('accept', () => {
    it('RPUSHes the fragment, expires the list, and schedules a delayed flush job', async () => {
      txExec.mockResolvedValue([
        [null, 1],
        [null, 1],
      ]);
      redisMock.get.mockResolvedValue(null);
      queueMock.add.mockResolvedValue({ id: 'flush_ventas_c1_t1' });

      const result = await debouncer.accept({
        debounceKey: 'ventas',
        source: 'workflow',
        agentId: 'ventas',
        contactId: 'c1',
        body: 'hola',
        replyChannel: 'WhatsApp',
        contactName: 'Fabio',
        locationId: 'loc_abc',
        requestId: 'req-1',
      });

      expect(tx.rpush).toHaveBeenCalledWith(
        'debounce:msgs:ventas:c1',
        expect.stringContaining('"body":"hola"'),
      );
      expect(tx.rpush).toHaveBeenCalledWith(
        'debounce:msgs:ventas:c1',
        expect.stringContaining('"contactName":"Fabio"'),
      );
      expect(tx.rpush).toHaveBeenCalledWith(
        'debounce:msgs:ventas:c1',
        expect.stringContaining('"locationId":"loc_abc"'),
      );
      expect(tx.expire).toHaveBeenCalledWith('debounce:msgs:ventas:c1', 300);

      expect(queueMock.add).toHaveBeenCalledTimes(1);
      const [name, data, opts] = queueMock.add.mock.calls[0];
      expect(name).toBe(WEBHOOK_FLUSH_JOB);
      expect(data).toEqual({
        debounceKey: 'ventas',
        contactId: 'c1',
        source: 'workflow',
        agentId: 'ventas',
        locationId: 'loc_abc',
      });
      expect(opts.delay).toBe(10_000);
      expect(opts.attempts).toBe(3);
      expect(opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
      expect(opts.jobId).toMatch(/^flush_ventas_c1_\d+-[0-9a-f]+$/);
      expect(opts.removeOnComplete).toBe(true);

      expect(redisMock.set).toHaveBeenCalledWith('debounce:flush:ventas:c1', opts.jobId, 'EX', 300);

      expect(result.pendingCount).toBe(1);
    });

    it('sanitizes the colon in inbound debounceKey when building the BullMQ jobId', async () => {
      txExec.mockResolvedValue([
        [null, 1],
        [null, 1],
      ]);
      redisMock.get.mockResolvedValue(null);
      queueMock.add.mockResolvedValue({ id: 'flush_loc_LOC123_c1_t1' });

      await debouncer.accept({
        debounceKey: 'loc:LOC123',
        source: 'inbound',
        contactId: 'c1',
        locationId: 'LOC123',
        body: 'hola',
        replyChannel: 'WhatsApp',
        requestId: 'msg_1',
      });

      const [, data, opts] = queueMock.add.mock.calls[0];
      expect(data).toEqual({
        debounceKey: 'loc:LOC123',
        contactId: 'c1',
        source: 'inbound',
        agentId: undefined,
        locationId: 'LOC123',
      });
      expect(opts.jobId).toMatch(/^flush_loc_LOC123_c1_\d+-[0-9a-f]+$/);
      expect(opts.jobId).not.toContain(':');
    });

    it('removes the previously-scheduled flush job before adding a new one', async () => {
      txExec.mockResolvedValue([
        [null, 2],
        [null, 1],
      ]);
      redisMock.get.mockResolvedValue('flush_ventas_c1_older');
      const remove = jest.fn().mockResolvedValue(undefined);
      queueMock.getJob.mockResolvedValue({ remove });
      queueMock.add.mockResolvedValue({ id: 'flush_ventas_c1_newer' });

      await debouncer.accept({
        debounceKey: 'ventas',
        source: 'workflow',
        agentId: 'ventas',
        contactId: 'c1',
        body: 'segundo',
        replyChannel: 'WhatsApp',
        requestId: undefined,
      });

      expect(queueMock.getJob).toHaveBeenCalledWith('flush_ventas_c1_older');
      expect(remove).toHaveBeenCalledTimes(1);
    });

    it('swallows remove() errors when the previous job is already running', async () => {
      txExec.mockResolvedValue([
        [null, 1],
        [null, 1],
      ]);
      redisMock.get.mockResolvedValue('flush_ventas_c1_active');
      queueMock.getJob.mockResolvedValue({
        remove: jest.fn().mockRejectedValue(new Error('locked')),
      });
      queueMock.add.mockResolvedValue({ id: 'flush_ventas_c1_newer' });

      await expect(
        debouncer.accept({
          debounceKey: 'ventas',
          source: 'workflow',
          agentId: 'ventas',
          contactId: 'c1',
          body: 'msg',
          replyChannel: 'WhatsApp',
          requestId: undefined,
        }),
      ).resolves.toBeDefined();

      expect(queueMock.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('drain', () => {
    it('snapshots and clears the list, returning parsed entries', async () => {
      const entries = [
        JSON.stringify({
          body: 'a',
          replyChannel: 'WhatsApp',
          contactName: 'First Name',
          requestId: 'r1',
          receivedAt: '2026-04-28T00:00:00.000Z',
        }),
        JSON.stringify({
          body: 'b',
          replyChannel: 'IG',
          contactName: 'Last Name',
          requestId: 'r2',
          receivedAt: '2026-04-28T00:00:01.000Z',
        }),
      ];
      txExec.mockResolvedValue([
        [null, entries],
        [null, 1],
        [null, 1],
      ]);

      const items = await debouncer.drain('ventas', 'c1');

      expect(tx.lrange).toHaveBeenCalledWith('debounce:msgs:ventas:c1', 0, -1);
      expect(tx.del).toHaveBeenCalledWith('debounce:msgs:ventas:c1');
      expect(tx.del).toHaveBeenCalledWith('debounce:flush:ventas:c1');
      expect(items).toHaveLength(2);
      expect(items[0].body).toBe('a');
      expect(items[0].contactName).toBe('First Name');
      expect(items[1].replyChannel).toBe('IG');
      expect(items[1].contactName).toBe('Last Name');
    });

    it('returns an empty array when the list is empty', async () => {
      txExec.mockResolvedValue([
        [null, []],
        [null, 0],
        [null, 0],
      ]);
      const items = await debouncer.drain('ventas', 'c1');
      expect(items).toEqual([]);
    });

    it('skips malformed JSON entries instead of throwing', async () => {
      const entries = [
        '{not json',
        JSON.stringify({
          body: 'ok',
          replyChannel: 'WhatsApp',
          requestId: undefined,
          receivedAt: '2026-04-28T00:00:00.000Z',
        }),
      ];
      txExec.mockResolvedValue([
        [null, entries],
        [null, 1],
        [null, 0],
      ]);

      const items = await debouncer.drain('ventas', 'c1');
      expect(items).toHaveLength(1);
      expect(items[0].body).toBe('ok');
    });
  });
});
