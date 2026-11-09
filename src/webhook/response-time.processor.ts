import { InjectRepository } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { AppEnv } from '../config/env.validation';
import { AdvisorResponseTime } from './advisor-response-time.entity';
import { ResponseTimeJob } from './response-time.tracker';
import { RESPONSE_TIME_QUEUE_TOKEN } from './webhook.tokens';

/**
 * Persists advisor response times. Lives on its own queue so a slow or down
 * Postgres can never back up (or be backed up by) the webhook queue.
 */
@Processor(RESPONSE_TIME_QUEUE_TOKEN)
export class ResponseTimeProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(ResponseTimeProcessor.name);

  constructor(
    private readonly config: ConfigService<AppEnv, true>,
    @InjectRepository(AdvisorResponseTime)
    private readonly repo: Repository<AdvisorResponseTime>,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get('PROCESS_JOBS', { infer: true })) {
      await this.worker.close();
    }
  }

  async process(job: Job<ResponseTimeJob>): Promise<void> {
    const d = job.data;
    const responseSeconds = Math.max(0, Math.round((d.repliedAt - d.inboundAt) / 1000));

    // orIgnore → ON CONFLICT DO NOTHING on the unique outbound_message_id, so a
    // retried job never produces a duplicate row.
    await this.repo
      .createQueryBuilder()
      .insert()
      .values({
        locationId: d.locationId,
        contactId: d.contactId,
        userId: d.userId,
        channel: d.channel ?? null,
        inboundMessageId: d.inboundMessageId ?? null,
        outboundMessageId: d.outboundMessageId,
        inboundAt: new Date(d.inboundAt),
        repliedAt: new Date(d.repliedAt),
        responseSeconds,
      })
      .orIgnore()
      .execute();

    this.logger.debug(
      { jobId: job.id, userId: d.userId, responseSeconds },
      'advisor response time persisted',
    );
  }
}
