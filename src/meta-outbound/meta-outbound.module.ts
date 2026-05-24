import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TokenCipher } from '../common/crypto/token-cipher';
import { MetaChannel } from './entities/meta-channel.entity';
import { MetaChannelRepository } from './meta-channel.repository';
import { WhatsAppCloudClient } from './whatsapp-cloud-client';

/**
 * Outbound Meta (WhatsApp Cloud) sending. Owns the per-tenant credential store.
 *
 * Imported by `AppModule` ONLY when `META_OUTBOUND_ENABLED=true`, alongside
 * `DatabaseModule`. With the flag off (the default) neither this module nor
 * Postgres are wired, so the service — including the Redis-only inbound webhook
 * path — boots without a database.
 */
@Module({
  imports: [TypeOrmModule.forFeature([MetaChannel])],
  providers: [TokenCipher, MetaChannelRepository, WhatsAppCloudClient],
  exports: [MetaChannelRepository, WhatsAppCloudClient],
})
export class MetaOutboundModule {}
