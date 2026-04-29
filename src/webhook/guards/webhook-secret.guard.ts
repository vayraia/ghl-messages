import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';
import { AppEnv } from '../../config/env.validation';
import { WEBHOOK_SECRET_HEADER } from '../webhook.constants';

/**
 * Validates the `x-webhook-secret` header against the configured secret using
 * a constant-time comparison so attackers cannot infer the secret from
 * response-time differences.
 */
@Injectable()
export class WebhookSecretGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(config: ConfigService<AppEnv, true>) {
    const secret: string = config.get('WEBHOOK_SECRET', { infer: true });
    this.expected = Buffer.from(secret, 'utf8');
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const provided = req.header(WEBHOOK_SECRET_HEADER);

    if (typeof provided !== 'string' || provided.length === 0) {
      throw new UnauthorizedException('Missing webhook secret');
    }

    const providedBuf = Buffer.from(provided, 'utf8');
    if (providedBuf.length !== this.expected.length) {
      // Still do a timing-safe compare against a same-length buffer to
      // avoid leaking length differences via response time.
      timingSafeEqual(this.expected, this.expected);
      throw new UnauthorizedException('Invalid webhook secret');
    }

    if (!timingSafeEqual(providedBuf, this.expected)) {
      throw new UnauthorizedException('Invalid webhook secret');
    }

    return true;
  }
}
