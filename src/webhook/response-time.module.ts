import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdvisorResponseTime } from './advisor-response-time.entity';
import { ResponseTimeProcessor } from './response-time.processor';
import { RESPONSE_TIME_QUEUE_TOKEN } from './webhook.tokens';

/**
 * Postgres persistence for advisor response times. Kept apart from
 * `WebhookModule` because it needs a TypeORM connection: `app.module.ts` only
 * loads it (together with `DatabaseModule`) when `DATABASE_URL` is set,
 * so the Redis-only inbound path still boots without a database.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AdvisorResponseTime]),
    BullModule.registerQueue({ name: RESPONSE_TIME_QUEUE_TOKEN }),
  ],
  providers: [ResponseTimeProcessor],
})
export class ResponseTimeModule {}
