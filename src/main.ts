import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import compression from 'compression';
import helmet from 'helmet';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AppModule } from './app.module';
import { AppEnv } from './config/env.validation';
import { setupBullBoard } from './common/bull-board/bull-board.setup';

// Meta webhooks require HMAC-SHA256 over the raw request body. The JSON
// parser consumes the buffer, so we copy it into `req.rawBody` first via
// body-parser's `verify` hook. Only the Meta signature guard reads it.
function captureRawBody(req: Request, _res: unknown, buf: Buffer): void {
  if (buf?.length) {
    req.rawBody = Buffer.from(buf);
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });

  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService<AppEnv, true>);
  const port = config.get('PORT', { infer: true });
  const bodyLimit = config.get('BODY_LIMIT', { infer: true });

  // Mount the Bull Board dashboard (no-op unless BULL_BOARD_ENABLED) BEFORE
  // helmet so its inline assets are not blocked by the global CSP. It is
  // Basic-Auth-gated and only served on this HTTP tier, never on the worker.
  setupBullBoard(app, config);

  app.use(helmet());
  app.use(compression());
  app.useBodyParser('json', { limit: bodyLimit, verify: captureRawBody });
  app.useBodyParser('urlencoded', { extended: true, limit: bodyLimit });

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableShutdownHooks();
  app.set('trust proxy', 1);

  await app.listen(port, '0.0.0.0');
  app.get(Logger).log(`HTTP listening on :${port}`, 'Bootstrap');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
