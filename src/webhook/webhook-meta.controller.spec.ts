import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../config/env.validation';
import { WebhookMetaController } from './webhook-meta.controller';

const VERIFY_TOKEN = 'verify-token-tests-xyz';

function makeController(): WebhookMetaController {
  const config = {
    get: (key: string) => (key === 'META_VERIFY_TOKEN' ? VERIFY_TOKEN : undefined),
  } as unknown as ConfigService<AppEnv, true>;
  return new WebhookMetaController(config);
}

describe('WebhookMetaController', () => {
  describe('verify (GET handshake)', () => {
    it('echoes hub.challenge when the verify token matches', () => {
      const c = makeController();
      const out = c.verify({
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '12345',
      });
      expect(out).toBe('12345');
    });

    it('rejects when mode is not subscribe', () => {
      const c = makeController();
      expect(() =>
        c.verify({
          'hub.mode': 'unsubscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': 'x',
        }),
      ).toThrow(ForbiddenException);
    });

    it('rejects when the verify token does not match', () => {
      const c = makeController();
      expect(() =>
        c.verify({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong-token',
          'hub.challenge': 'x',
        }),
      ).toThrow(ForbiddenException);
    });

    it('rejects when hub.challenge is missing', () => {
      const c = makeController();
      expect(() =>
        c.verify({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN }),
      ).toThrow(ForbiddenException);
    });
  });

  describe('receive (POST events)', () => {
    it('acks with { ok: true } regardless of payload shape', () => {
      const c = makeController();
      expect(c.receive({})).toEqual({ ok: true });
      expect(c.receive(null)).toEqual({ ok: true });
      expect(
        c.receive({
          object: 'page',
          entry: [{ id: 'P', messaging: [{ sender: { id: 's' }, message: { text: 'hi' } }] }],
        }),
      ).toEqual({ ok: true });
    });
  });
});
