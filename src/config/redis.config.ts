import { ConfigService } from '@nestjs/config';
import { RedisOptions } from 'ioredis';
import { AppEnv } from './env.validation';

/**
 * Build ioredis-compatible options from `REDIS_URL`.
 *
 * Accepts both `redis://` (plain TCP) and `rediss://` (TLS) URLs of the
 * form `redis[s]://[user[:password]@]host[:port][/db]`.
 *
 * Always returns `maxRetriesPerRequest: null` because BullMQ's blocking
 * commands require it.
 */
export function buildRedisOptions(config: ConfigService<AppEnv, true>): RedisOptions {
  const url = config.get('REDIS_URL', { infer: true });
  return parseRedisUrl(url);
}

export function parseRedisUrl(url: string): RedisOptions {
  const parsed = new URL(url);

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`Unsupported Redis URL scheme: ${parsed.protocol}`);
  }

  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 6379;
  const dbSegment = parsed.pathname.replace(/^\//, '');
  const db = dbSegment === '' ? 0 : Number.parseInt(dbSegment, 10);

  return {
    host: parsed.hostname,
    port,
    db: Number.isFinite(db) ? db : 0,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  };
}
