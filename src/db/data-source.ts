import 'dotenv/config';
import { DataSource } from 'typeorm';

/**
 * Standalone DataSource used ONLY by the TypeORM CLI (migrations). The running
 * app builds its own connection in `DatabaseModule` from `ConfigService`; this
 * file exists so `yarn migration:run` / `migration:generate` work outside Nest.
 *
 * Env is loaded from `.env` via `dotenv/config`.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL must be set to run TypeORM CLI commands');
}

export default new DataSource({
  type: 'postgres',
  url,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/db/migrations/*.ts'],
});
