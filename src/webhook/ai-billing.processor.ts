import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { Job, UnrecoverableError } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { AiBillingEvent } from './ai-billing-notifier';
import { AI_BILLING_QUEUE_TOKEN } from './webhook.tokens';

const REGISTER_PATH = '/billing/ai-contacts/register';

/**
 * Delivers the "the AI answered this contact" events to `ai`
 * (`POST CHAT_API_URL/billing/ai-contacts/register`, service key). Its own queue,
 * so a slow or down `ai` never backs up the webhook queue.
 *
 *  - 2xx          → done (`ai` decides whether it counts or is skipped).
 *  - 4xx (not 429) → misconfiguration (wrong key, bad payload): not retried.
 *  - 429 / 5xx / network → retried by BullMQ.
 * The service key is never logged.
 */
@Processor(AI_BILLING_QUEUE_TOKEN)
export class AiBillingProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(AiBillingProcessor.name);
  private readonly client: AxiosInstance;

  constructor(private readonly config: ConfigService<AppEnv, true>) {
    super();
    const apiKey = config.get('AI_SERVICE_API_KEY', { infer: true })?.trim() ?? '';
    this.client = axios.create({
      baseURL: config.get('CHAT_API_URL', { infer: true }),
      timeout: config.get('CHAT_API_TIMEOUT_MS', { infer: true }),
      headers: { 'content-type': 'application/json', 'X-API-Key': apiKey },
      validateStatus: () => true,
      maxRedirects: 0,
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get('PROCESS_JOBS', { infer: true })) {
      await this.worker.close();
    }
  }

  async process(job: Job<AiBillingEvent>): Promise<void> {
    const { locationId, contactId, jobId, occurredAt } = job.data;
    let response;
    try {
      response = await this.client.post(REGISTER_PATH, {
        location_id: locationId,
        contact_id: contactId,
        job_id: jobId,
        occurred_at: occurredAt,
      });
    } catch (err) {
      throw new Error(`ai billing register transport error: ${(err as Error).message}`);
    }

    const { status } = response;
    if (status >= 200 && status < 300) {
      this.logger.debug({ jobId, contactId, status }, 'AI billing event delivered');
      return;
    }
    if (status >= 400 && status < 500 && status !== 429) {
      this.logger.warn({ jobId, contactId, status }, 'ai rejected the billing event — not retried');
      throw new UnrecoverableError(`ai rejected the billing event with ${status}`);
    }
    throw new Error(`ai billing register returned ${status}`);
  }
}
