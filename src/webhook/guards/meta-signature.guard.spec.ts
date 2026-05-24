import { createHmac } from 'crypto';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../../config/env.validation';
import { META_SIGNATURE_HEADER } from '../webhook.constants';
import { MetaSignatureGuard } from './meta-signature.guard';

const APP_SECRET = 'meta-app-secret-value-for-tests-12345';

function sign(body: Buffer, secret: string = APP_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function makeContext(
  headers: Record<string, string | undefined>,
  rawBody?: Buffer,
): ExecutionContext {
  const req = {
    header: (name: string) => headers[name.toLowerCase()],
    rawBody,
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeGuard(secret: string = APP_SECRET): MetaSignatureGuard {
  const config = {
    get: (key: string) => (key === 'META_APP_SECRET' ? secret : undefined),
  } as unknown as ConfigService<AppEnv, true>;
  return new MetaSignatureGuard(config);
}

describe('MetaSignatureGuard', () => {
  it('allows requests with a valid sha256 signature', () => {
    const guard = makeGuard();
    const body = Buffer.from('{"object":"page","entry":[]}');
    const ctx = makeContext({ [META_SIGNATURE_HEADER]: sign(body) }, body);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects when the header is missing', () => {
    const guard = makeGuard();
    const ctx = makeContext({}, Buffer.from('x'));
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the header has no sha256= prefix', () => {
    const guard = makeGuard();
    const body = Buffer.from('x');
    const bareHex = createHmac('sha256', APP_SECRET).update(body).digest('hex');
    const ctx = makeContext({ [META_SIGNATURE_HEADER]: bareHex }, body);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the signature is non-hex garbage', () => {
    const guard = makeGuard();
    const ctx = makeContext(
      { [META_SIGNATURE_HEADER]: 'sha256=not-hex-at-all' },
      Buffer.from('x'),
    );
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the raw body is missing', () => {
    const guard = makeGuard();
    const body = Buffer.from('{"object":"page"}');
    const ctx = makeContext({ [META_SIGNATURE_HEADER]: sign(body) }, undefined);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the signature was computed with the wrong secret', () => {
    const guard = makeGuard();
    const body = Buffer.from('{"object":"instagram"}');
    const wrong = sign(body, 'a-different-secret-that-is-long-enough');
    const ctx = makeContext({ [META_SIGNATURE_HEADER]: wrong }, body);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the body was tampered with', () => {
    const guard = makeGuard();
    const original = Buffer.from('{"object":"page","entry":[1]}');
    const tampered = Buffer.from('{"object":"page","entry":[2]}');
    const ctx = makeContext({ [META_SIGNATURE_HEADER]: sign(original) }, tampered);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects when the signature length differs from the expected length', () => {
    const guard = makeGuard();
    const body = Buffer.from('x');
    const ctx = makeContext({ [META_SIGNATURE_HEADER]: 'sha256=ab' }, body);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
