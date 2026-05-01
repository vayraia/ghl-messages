import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

@Controller({ path: 'webhook', version: ['1'] })
export class WebhookOutboundController {
  @Post('outbound')
  @HttpCode(HttpStatus.OK)
  outbound(): { ok: true } {
    return { ok: true };
  }
}
