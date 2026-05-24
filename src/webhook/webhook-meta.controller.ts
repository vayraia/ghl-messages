import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../config/env.validation';
import { MetaSignatureGuard } from './guards/meta-signature.guard';
import { summarizeMetaPayload } from './meta-tenant';

/**
 * Inbound endpoint for Meta Graph API webhooks (Messenger, Instagram
 * Messaging, WhatsApp Cloud API). For now this only logs events for
 * observation — it does NOT forward to the GHL pipeline or persist.
 *
 * Multi-tenant: a single POST can carry events for many connected
 * accounts. Each event is normalized to a `tenantKey` derived from the
 * Page id / IG account id / WhatsApp phone_number_id.
 */
@Controller({ path: 'webhook/meta', version: ['1'] })
export class WebhookMetaController {
  private readonly logger = new Logger(WebhookMetaController.name);
  private readonly verifyToken: string;

  constructor(config: ConfigService<AppEnv, true>) {
    this.verifyToken = config.get('META_VERIFY_TOKEN', { infer: true });
  }

  /**
   * Subscription verification handshake. Meta calls this once when the
   * webhook URL is registered. Must echo `hub.challenge` verbatim with a
   * 200 status when the verify token matches.
   *
   * https://developers.facebook.com/docs/graph-api/webhooks/getting-started
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/plain')
  verify(@Query() query: Record<string, string | undefined>): string {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode !== 'subscribe' || token !== this.verifyToken || typeof challenge !== 'string') {
      this.logger.warn(
        `meta verify rejected mode=${String(mode)} tokenMatch=${token === this.verifyToken}`,
      );
      throw new ForbiddenException('Invalid verify token');
    }

    this.logger.log('meta verify handshake OK');
    return challenge;
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(MetaSignatureGuard)
  receive(@Body() body: unknown): { ok: true } {
    const summary = summarizeMetaPayload(body);
    this.logger.log(
      `meta inbound object=${summary.object} entries=${summary.entries} events=${JSON.stringify(summary.events)}`,
    );
    this.logger.debug?.(`meta inbound raw: ${JSON.stringify(body)}`);
    return { ok: true };
  }
}
