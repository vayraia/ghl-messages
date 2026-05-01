import { Body, Controller, HttpCode, HttpStatus, Logger, Post } from '@nestjs/common';

@Controller({ path: 'webhook', version: ['1'] })
export class WebhookOutboundController {
  private readonly logger = new Logger(WebhookOutboundController.name);

  @Post('outbound')
  @HttpCode(HttpStatus.OK)
  outbound(@Body() body: unknown): { ok: true } {
    this.logger.log(`outbound payload: ${JSON.stringify(body)}`);
    return { ok: true };
  }
}
