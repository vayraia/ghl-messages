import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

/**
 * Standalone worker entrypoint.
 *
 * Starts the same Nest application without binding to an HTTP port, so the
 * BullMQ processors run in dedicated processes/containers separate from the
 * API tier. Run with: `node dist/worker.js`.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  app.get(Logger).log('Webhook worker started', 'Worker');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal worker bootstrap error', err);
  process.exit(1);
});
