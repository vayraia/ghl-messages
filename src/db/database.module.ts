import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppEnv } from '../config/env.validation';

/**
 * Postgres connection bootstrap shared by the API and worker processes (both
 * boot `AppModule`). Entities register themselves through
 * `TypeOrmModule.forFeature` in their owning feature module — `autoLoadEntities`
 * wires them in here.
 *
 * `synchronize` is always off: the schema is owned by explicit migrations
 * (`yarn migration:run`), never by entity auto-sync.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        type: 'postgres',
        url: config.get('DATABASE_URL', { infer: true }),
        ssl: config.get('DATABASE_SSL', { infer: true }) ? { rejectUnauthorized: false } : false,
        autoLoadEntities: true,
        synchronize: false,
        migrationsRun: false,
        retryAttempts: 5,
      }),
    }),
  ],
})
export class DatabaseModule {}
