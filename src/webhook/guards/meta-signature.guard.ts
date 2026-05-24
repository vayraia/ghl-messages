import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { AppEnv } from '../../config/env.validation';
import { META_SIGNATURE_HEADER } from '../webhook.constants';

/**
 * Verifies the `X-Hub-Signature-256` header sent by Meta webhook deliveries
 * (Messenger / Instagram / WhatsApp Cloud API).
 *
 * The signature is HMAC-SHA256 over the raw request body keyed with the Meta
 * app secret. The raw body is captured by the `verify` hook installed on the
 * JSON body-parser in `main.ts`; without it, validation cannot succeed.
 */
@Injectable()
export class MetaSignatureGuard implements CanActivate {
  private readonly appSecret: string;

  constructor(config: ConfigService<AppEnv, true>) {
    this.appSecret = config.get('META_APP_SECRET', { infer: true });
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.header(META_SIGNATURE_HEADER);

    if (typeof header !== 'string' || !header.startsWith('sha256=')) {
      throw new UnauthorizedException('Missing or malformed Meta signature');
    }

    const providedHex = header.slice('sha256='.length);
    if (providedHex.length === 0 || !/^[0-9a-f]+$/i.test(providedHex)) {
      throw new UnauthorizedException('Invalid Meta signature encoding');
    }

    const rawBody = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      throw new UnauthorizedException('Missing raw body for Meta signature');
    }

    const expectedHex = createHmac('sha256', this.appSecret).update(rawBody).digest('hex');

    const provided = Buffer.from(providedHex, 'hex');
    const expected = Buffer.from(expectedHex, 'hex');

    if (provided.length !== expected.length) {
      throw new UnauthorizedException('Invalid Meta signature');
    }
    if (!timingSafeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid Meta signature');
    }
    return true;
  }
}
