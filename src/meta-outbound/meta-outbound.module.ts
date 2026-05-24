import { Module, OnApplicationShutdown } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Redis } from 'ioredis';
import { AppEnv } from '../config/env.validation';
import { buildRedisOptions } from '../config/redis.config';
import { TokenCipher } from '../common/crypto/token-cipher';
import { WebhookSecretGuard } from '../webhook/guards/webhook-secret.guard';
import { MetaChannel } from './entities/meta-channel.entity';
import { MetaChannelAdminService } from './meta-channel-admin.service';
import { MetaChannelController } from './meta-channel.controller';
import { MetaChannelRepository } from './meta-channel.repository';
import { META_OUTBOUND_QUEUE_TOKEN, META_OUTBOUND_REDIS_CLIENT } from './meta-outbound.constants';
import { MetaSendController } from './meta-send.controller';
import { MetaSendProcessor } from './meta-send.processor';
import { MetaSendService } from './meta-send.service';
import { WhatsAppCloudClient } from './whatsapp-cloud-client';

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

/**
 * Outbound Meta (WhatsApp Cloud) sending: credential store, send endpoint,
 * queue and worker.
 *
 * Imported by `AppModule` ONLY when `META_OUTBOUND_ENABLED=true`, alongside
 * `DatabaseModule`. With the flag off (the default) neither this module nor
 * Postgres are wired, so the service — including the Redis-only inbound webhook
 * path — boots without a database.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([MetaChannel]),
    BullModule.registerQueue({
      name: META_OUTBOUND_QUEUE_TOKEN,
      defaultJobOptions: {
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400 },
      },
    }),
  ],
  controllers: [MetaSendController, MetaChannelController],
  providers: [
    {
      provide: META_OUTBOUND_REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>): Redis =>
        new Redis(buildRedisOptions(config)),
    },
    {
      provide: RedisClientLifecycle,
      inject: [META_OUTBOUND_REDIS_CLIENT],
      useFactory: (client: Redis) => new RedisClientLifecycle(client),
    },
    TokenCipher,
    MetaChannelRepository,
    MetaChannelAdminService,
    WhatsAppCloudClient,
    MetaSendService,
    MetaSendProcessor,
    WebhookSecretGuard,
  ],
  exports: [MetaChannelRepository, WhatsAppCloudClient],
})
export class MetaOutboundModule {}
