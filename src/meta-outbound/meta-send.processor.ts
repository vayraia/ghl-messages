import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { MetaChannelRepository } from './meta-channel.repository';
import { META_OUTBOUND_QUEUE_TOKEN, META_SEND_JOB } from './meta-outbound.constants';
import { MetaSendJobData } from './meta-send.service';
import { WhatsAppCloudClient } from './whatsapp-cloud-client';

export interface MetaSendJobResult {
  ok: true;
  wamid?: string;
  status?: number;
  skipped?: 'unknown_job';
}

/**
 * Drains the `meta-outbound` queue: resolves the tenant's credentials, then
 * ships the pre-built body to the WhatsApp Cloud API. Credential problems
 * (channel missing or disabled) are non-retryable — retrying can't fix config.
 * Transient transport / 5xx / rate-limit failures bubble up so BullMQ retries.
 */
@Processor(META_OUTBOUND_QUEUE_TOKEN)
export class MetaSendProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(MetaSendProcessor.name);

  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    private readonly channels: MetaChannelRepository,
    private readonly client: WhatsAppCloudClient,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    // Ingest-only tiers (PROCESS_JOBS=false) close the auto-started worker so
    // job processing stays on the dedicated worker process only.
    if (!this.config.get('PROCESS_JOBS', { infer: true })) {
      await this.worker.close();
      this.logger.log('PROCESS_JOBS=false — meta-outbound worker closed (ingest-only process)');
      return;
    }
    this.worker.concurrency = this.config.get('META_OUTBOUND_CONCURRENCY', { infer: true });
  }

  async process(job: Job<MetaSendJobData, unknown, string>): Promise<MetaSendJobResult> {
    if (job.name !== META_SEND_JOB) {
      this.logger.warn({ name: job.name }, 'Unknown job name received');
      return { ok: true, skipped: 'unknown_job' };
    }

    const { phoneNumberId, body } = job.data;
    const jobId = String(job.id);

    const channel = await this.channels.findByPhoneNumberId(phoneNumberId);
    if (!channel) {
      throw new UnrecoverableError(
        `No meta_channel configured for phone_number_id=${phoneNumberId}`,
      );
    }
    if (channel.status !== 'active') {
      throw new UnrecoverableError(
        `meta_channel for phone_number_id=${phoneNumberId} is ${channel.status}`,
      );
    }

    const result = await this.client.send({
      jobId,
      phoneNumberId,
      accessToken: channel.accessToken,
      version: channel.graphApiVersion,
      body,
    });

    this.logger.log(
      {
        jobId,
        phoneNumberId,
        wamid: result.wamid,
        status: result.status,
        attempt: job.attemptsMade + 1,
      },
      'Outbound WhatsApp message sent',
    );
    return { ok: true, wamid: result.wamid, status: result.status };
  }
}
