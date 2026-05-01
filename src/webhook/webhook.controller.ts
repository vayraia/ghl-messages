import { Body, Controller, Headers, HttpCode, HttpStatus, Logger, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { WebhookSecretGuard } from './guards/webhook-secret.guard';
import { WebhookPayloadDto } from './dto/webhook-payload.dto';
import { WebhookService } from './webhook.service';
import { WEBHOOK_IDEMPOTENCY_HEADER } from './webhook.constants';
import { REQUEST_ID_HEADER } from '../common/middleware/request-id.middleware';

export interface IngestResponse {
  accepted: true;
  jobId: string;
  deduplicated: boolean;
  debounced: boolean;
}

@Controller({ path: 'webhook', version: ['1'] })
@UseGuards(WebhookSecretGuard)
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly service: WebhookService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async ingest(
    @Req() req: Request,
    @Body() payload: WebhookPayloadDto,
    @Headers(WEBHOOK_IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @Headers(REQUEST_ID_HEADER) requestId: string | undefined,
  ): Promise<IngestResponse> {
    this.logger.log(`inbound payload: ${JSON.stringify(req.body)}`);
    const result = await this.service.ingest(payload, { idempotencyKey, requestId });
    return {
      accepted: true,
      jobId: result.jobId,
      deduplicated: result.deduplicated,
      debounced: result.debounced,
    };
  }
}
