import { timingSafeEqual } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { Queue } from 'bullmq';
import express, { type RequestHandler } from 'express';
import { AppEnv } from '../../config/env.validation';
import { META_OUTBOUND_QUEUE_TOKEN } from '../../meta-outbound/meta-outbound.constants';
import { WEBHOOK_QUEUE_TOKEN } from '../../webhook/webhook.tokens';

/** URL prefix under which the dashboard is served. */
export const BULL_BOARD_PATH = '/admin/queues';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch; compare lengths first (the
  // length itself is not secret) so a wrong-length guess doesn't leak via the
  // exception path.
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** HTTP Basic Auth gate for the dashboard. Constant-time credential check. */
export function basicAuth(user: string, password: string): RequestHandler {
  return (req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, p] = Buffer.from(encoded, 'base64').toString().split(':');
      if (u !== undefined && p !== undefined && safeEqual(u, user) && safeEqual(p, password)) {
        next();
        return;
      }
    }
    res
      .set('WWW-Authenticate', 'Basic realm="Bull Board", charset="UTF-8"')
      .status(401)
      .send('Authentication required');
  };
}

/**
 * Mounts the Bull Board dashboard on the HTTP tier when `BULL_BOARD_ENABLED`.
 *
 * No-op unless enabled, so the worker entrypoint (which never calls this) and
 * production-by-default stay untouched. Registered BEFORE `helmet()` in
 * `main.ts` so the dashboard's inline assets are not blocked by the global CSP;
 * helmet still applies to every other route. The `meta-outbound` queue is only
 * wired when its module is loaded (`META_OUTBOUND_ENABLED`), so it is added
 * conditionally to avoid an unresolved-provider error.
 */
export function setupBullBoard(
  app: NestExpressApplication,
  config: ConfigService<AppEnv, true>,
): void {
  if (!config.get('BULL_BOARD_ENABLED', { infer: true })) {
    return;
  }

  const user = config.get('BULL_BOARD_USER', { infer: true });
  const password = config.get('BULL_BOARD_PASSWORD', { infer: true });
  // Env validation makes both required when enabled; this guard narrows the
  // types and fails loud if that invariant is ever bypassed.
  if (!user || !password) {
    throw new Error('BULL_BOARD_ENABLED is true but BULL_BOARD_USER/PASSWORD are not set');
  }

  const queues: Queue[] = [app.get<Queue>(getQueueToken(WEBHOOK_QUEUE_TOKEN))];
  if (config.get('META_OUTBOUND_ENABLED', { infer: true })) {
    queues.push(app.get<Queue>(getQueueToken(META_OUTBOUND_QUEUE_TOKEN)));
  }

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);
  createBullBoard({
    queues: queues.map((queue) => new BullMQAdapter(queue)),
    serverAdapter,
  });

  // `express.json()` is scoped to this mount so the dashboard's POST actions
  // (retry / clean / promote) parse their bodies without touching the global
  // raw-body parser used for Meta signature verification.
  app.use(BULL_BOARD_PATH, basicAuth(user, password), express.json(), serverAdapter.getRouter());
}
