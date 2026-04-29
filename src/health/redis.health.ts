import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import IORedis, { Redis } from 'ioredis';
import { AppEnv } from '../config/env.validation';
import { buildRedisOptions } from '../config/redis.config';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  private client: Redis | undefined;

  constructor(private readonly config: ConfigService<AppEnv, true>) {
    super();
  }

  private getClient(): Redis {
    if (!this.client) {
      this.client = new IORedis({ ...buildRedisOptions(this.config), lazyConnect: true });
    }
    return this.client;
  }

  async ping(key = 'redis'): Promise<HealthIndicatorResult> {
    try {
      const client = this.getClient();
      if (client.status === 'end' || client.status === 'wait') {
        await client.connect();
      }
      const pong = await client.ping();
      const healthy = pong === 'PONG';
      const result = this.getStatus(key, healthy);
      if (!healthy) {
        throw new HealthCheckError('Redis ping failed', result);
      }
      return result;
    } catch (err) {
      throw new HealthCheckError(
        'Redis ping failed',
        this.getStatus(key, false, {
          message: err instanceof Error ? err.message : 'unknown error',
        }),
      );
    }
  }
}
