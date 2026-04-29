import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { RedisHealthIndicator } from './redis.health';

@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /** Liveness — process is up. Used by orchestrators to decide whether to restart. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness — process is ready to accept traffic (Redis reachable). */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.redis.ping('redis')]);
  }
}
