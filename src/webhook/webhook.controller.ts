import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
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
  constructor(private readonly service: WebhookService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async ingest(
    @Body() payload: WebhookPayloadDto,
    @Headers(WEBHOOK_IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @Headers(REQUEST_ID_HEADER) requestId: string | undefined,
  ): Promise<IngestResponse> {
    const result = await this.service.ingest(payload, { idempotencyKey, requestId });
    return {
      accepted: true,
      jobId: result.jobId,
      deduplicated: result.deduplicated,
      debounced: result.debounced,
    };
  }
}
