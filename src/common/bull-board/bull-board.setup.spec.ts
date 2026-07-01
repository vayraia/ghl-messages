import express from 'express';
import request from 'supertest';
import { basicAuth, setupBullBoard } from './bull-board.setup';

const USER = 'admin';
const PASSWORD = 'supersecretpassword';

// Tiny app that puts `basicAuth` in front of a trivial handler, so the gate is
// exercised end-to-end (header parsing, 401 path, pass-through) without any
// queue, adapter, or Redis.
function guardedApp(user = USER, password = PASSWORD) {
  const app = express();
  app.use('/guarded', basicAuth(user, password), (_req, res) => res.send('ok'));
  return app;
}

describe('basicAuth', () => {
  it('rejects requests with no Authorization header (401 + WWW-Authenticate)', async () => {
    const res = await request(guardedApp()).get('/guarded').expect(401);
    expect(res.headers['www-authenticate']).toMatch(/^Basic/);
    expect(res.text).not.toBe('ok');
  });

  it('rejects a wrong password', async () => {
    await request(guardedApp()).get('/guarded').auth(USER, 'nope').expect(401);
  });

  it('rejects a wrong username', async () => {
    await request(guardedApp()).get('/guarded').auth('root', PASSWORD).expect(401);
  });

  it('rejects a non-Basic scheme', async () => {
    await request(guardedApp())
      .get('/guarded')
      .set('Authorization', 'Bearer sometoken')
      .expect(401);
  });

  it('lets the correct credentials through', async () => {
    await request(guardedApp()).get('/guarded').auth(USER, PASSWORD).expect(200, 'ok');
  });
});

describe('setupBullBoard gating', () => {
  const call = (config: Record<string, unknown>) =>
    setupBullBoard(
      { get: () => undefined, use: () => undefined } as never,
      { get: (key: string) => config[key] } as never,
    );

  it('is a no-op (and never resolves queues) when disabled', () => {
    let used = false;
    setupBullBoard(
      { get: () => undefined, use: () => (used = true) } as never,
      { get: (key: string) => ({ BULL_BOARD_ENABLED: false })[key] } as never,
    );
    expect(used).toBe(false);
  });

  it('throws when enabled without credentials', () => {
    expect(() => call({ BULL_BOARD_ENABLED: true, META_OUTBOUND_ENABLED: false })).toThrow(
      /BULL_BOARD_USER\/PASSWORD/,
    );
  });
});
