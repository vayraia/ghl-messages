import * as dotenv from 'dotenv';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { LoggerModule } from './common/logger/logger.module';
import { envValidationSchema, AppEnv } from './config/env.validation';
import { buildRedisOptions } from './config/redis.config';
import { DatabaseModule } from './db/database.module';
import { MetaOutboundModule } from './meta-outbound/meta-outbound.module';
import { WebhookModule } from './webhook/webhook.module';
import { HealthModule } from './health/health.module';
import { OAuthModule } from './oauth/oauth.module';

// Load .env before the @Module imports array is evaluated so the
// META_OUTBOUND_ENABLED flag below can gate optional modules. ConfigModule
// re-reads .env later (idempotent — it never overrides existing vars).
// Skipped under test, where env is injected directly by the test setup.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}

// Outbound Meta (WhatsApp Cloud) sending depends on Postgres. Keep it — and the
// DB connection — entirely out of the graph unless explicitly enabled, so the
// Redis-only inbound path boots without a database.
const metaOutboundEnabled = process.env.META_OUTBOUND_ENABLED === 'true';
const metaOutboundImports = metaOutboundEnabled ? [DatabaseModule, MetaOutboundModule] : [];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: true, allowUnknown: true },
    }),
    LoggerModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        throttlers: [
          {
            ttl: config.get('THROTTLE_TTL_SECONDS', { infer: true }) * 1000,
            limit: config.get('THROTTLE_LIMIT', { infer: true }),
          },
        ],
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        connection: buildRedisOptions(config),
      }),
    }),
    ...metaOutboundImports,
    WebhookModule,
    HealthModule,
    OAuthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
