import { Controller, HttpCode, HttpStatus, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

@Controller({ path: 'webhook', version: ['1'] })
export class WebhookInboundController {
  private readonly logger = new Logger(WebhookInboundController.name);

  @Post('inbound')
  @HttpCode(HttpStatus.OK)
  inbound(@Req() req: Request): { ok: true } {
    this.logger.log(`inbound raw body: ${JSON.stringify(req.body)}`);
    return { ok: true };
  }
}
