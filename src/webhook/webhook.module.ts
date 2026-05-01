import { Module, OnApplicationShutdown } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { AppEnv } from '../config/env.validation';
import { buildRedisOptions } from '../config/redis.config';
import { WebhookController } from './webhook.controller';
import { WebhookOutboundController } from './webhook-outbound.controller';
import { WebhookService } from './webhook.service';
import { WebhookProcessor } from './webhook.processor';
import { WebhookForwarder } from './webhook-forwarder';
import { GhlReply } from './ghl-reply';
import { MessageDebouncer } from './message-debouncer';
import { WebhookSecretGuard } from './guards/webhook-secret.guard';
import { WEBHOOK_QUEUE_TOKEN, WEBHOOK_REDIS_CLIENT } from './webhook.tokens';

class RedisClientLifecycle implements OnApplicationShutdown {
  constructor(private readonly client: Redis) {}
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

@Module({
  imports: [
    BullModule.registerQueue({
      name: WEBHOOK_QUEUE_TOKEN,
      defaultJobOptions: {
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400 },
      },
    }),
  ],
  controllers: [WebhookController, WebhookOutboundController],
  providers: [
    {
      provide: WEBHOOK_REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>): Redis => {
        return new Redis(buildRedisOptions(config));
      },
    },
    {
      provide: RedisClientLifecycle,
      inject: [WEBHOOK_REDIS_CLIENT],
      useFactory: (client: Redis) => new RedisClientLifecycle(client),
    },
    WebhookService,
    WebhookProcessor,
    WebhookForwarder,
    GhlReply,
    MessageDebouncer,
    WebhookSecretGuard,
  ],
  exports: [WebhookService],
})
export class WebhookModule {}
