import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { WebhookSecretGuard } from '../webhook/guards/webhook-secret.guard';
import { WEBHOOK_IDEMPOTENCY_HEADER } from '../webhook/webhook.constants';
import { SendWhatsAppDto } from './dto/send-whatsapp.dto';
import { MetaSendService } from './meta-send.service';

export interface MetaSendResponse {
  accepted: true;
  jobId: string;
  deduplicated: boolean;
}

/**
 * Outbound send endpoint for WhatsApp Cloud messages. Called by internal
 * producers (AI pipeline / GHL workflow), authenticated with the same
 * `x-webhook-secret` as the inbound webhook. The request is validated and
 * enqueued; the Cloud API call happens asynchronously in the worker, so the
 * response is a 202 with the job id (no wamid yet — see follow-ups).
 */
@Controller({ path: 'messages/whatsapp', version: ['1'] })
@UseGuards(WebhookSecretGuard)
export class MetaSendController {
  constructor(private readonly service: MetaSendService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async send(
    @Body() dto: SendWhatsAppDto,
    @Headers(WEBHOOK_IDEMPOTENCY_HEADER) headerKey: string | undefined,
  ): Promise<MetaSendResponse> {
    const result = await this.service.enqueue(dto, {
      idempotencyKey: dto.idempotencyKey ?? headerKey,
    });
    return { accepted: true, jobId: result.jobId, deduplicated: result.deduplicated };
  }
}
