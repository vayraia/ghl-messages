import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookSecretGuard } from './webhook-secret.guard';
import { WEBHOOK_SECRET_HEADER } from '../webhook.constants';
import { AppEnv } from '../../config/env.validation';

const SECRET = 'super-secret-value-for-tests-12345';

function makeContext(headers: Record<string, string | undefined>): ExecutionContext {
  const req = {
    header: (name: string) => headers[name.toLowerCase()],
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeGuard(secret: string = SECRET): WebhookSecretGuard {
  const config = {
    get: (key: string) => (key === 'WEBHOOK_SECRET' ? secret : undefined),
  } as unknown as ConfigService<AppEnv, true>;
  return new WebhookSecretGuard(config);
}

describe('WebhookSecretGuard', () => {
  it('allows requests with the correct secret', () => {
    const guard = makeGuard();
    const ctx = makeContext({ [WEBHOOK_SECRET_HEADER]: SECRET });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects requests with no header', () => {
    const guard = makeGuard();
    const ctx = makeContext({});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects requests with an empty header', () => {
    const guard = makeGuard();
    const ctx = makeContext({ [WEBHOOK_SECRET_HEADER]: '' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects requests with a wrong secret of equal length', () => {
    const guard = makeGuard();
    const wrong = 'x'.repeat(SECRET.length);
    const ctx = makeContext({ [WEBHOOK_SECRET_HEADER]: wrong });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects requests with a wrong secret of different length without leaking via timing crash', () => {
    const guard = makeGuard();
    const ctx = makeContext({ [WEBHOOK_SECRET_HEADER]: 'short' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
