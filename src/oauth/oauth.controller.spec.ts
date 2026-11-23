import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AppEnv } from '../config/env.validation';
import { OAuthController } from './oauth.controller';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeController() {
  const get = jest.fn();
  mockedAxios.create.mockReturnValue({ get } as unknown as ReturnType<typeof axios.create>);
  const env: Record<string, string | number> = {
    CHAT_API_URL: 'http://ai.internal',
    CHAT_API_TIMEOUT_MS: 5000,
  };
  const config = { get: (k: string) => env[k] } as unknown as ConfigService<AppEnv, true>;
  const res = { type: jest.fn(), status: jest.fn() };
  return { controller: new OAuthController(config), get, res };
}

describe('OAuthController.callback', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates the client against CHAT_API_URL without following redirects', () => {
    makeController();
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://ai.internal',
        timeout: 5000,
        maxRedirects: 0,
      }),
    );
  });

  it('forwards only code to ai and relays its status and page', async () => {
    const { controller, get, res } = makeController();
    get.mockResolvedValue({ status: 200, data: '<h1>Instalación completada</h1>' });

    const body = await controller.callback(res as never, 'abc123', undefined);

    expect(get).toHaveBeenCalledWith('/ghl/oauth/billing/callback', { params: { code: 'abc123' } });
    expect(res.type).toHaveBeenCalledWith('html');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(body).toBe('<h1>Instalación completada</h1>');
  });

  it('forwards the error param when GHL reports a cancelled install', async () => {
    const { controller, get, res } = makeController();
    get.mockResolvedValue({ status: 400, data: '<h1>Instalación cancelada</h1>' });

    const body = await controller.callback(res as never, undefined, 'access_denied');

    expect(get).toHaveBeenCalledWith('/ghl/oauth/billing/callback', {
      params: { error: 'access_denied' },
    });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(body).toContain('cancelada');
  });

  it('relays upstream failures (e.g. 502 from the token exchange)', async () => {
    const { controller, get, res } = makeController();
    get.mockResolvedValue({ status: 502, data: '<h1>No se pudo completar</h1>' });
    await controller.callback(res as never, 'abc', undefined);
    expect(res.status).toHaveBeenCalledWith(502);
  });

  it('answers 502 with a page when ai is unreachable, without leaking the code', async () => {
    const { controller, get, res } = makeController();
    get.mockRejectedValue(new Error('ECONNREFUSED'));

    const body = await controller.callback(res as never, 'secret-code', undefined);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(body).toContain('No se pudo completar la instalación');
    expect(body).not.toContain('secret-code');
  });

  it('sends no params when GHL called without code or error', async () => {
    const { controller, get, res } = makeController();
    get.mockResolvedValue({ status: 400, data: '' });
    await controller.callback(res as never, undefined, undefined);
    expect(get).toHaveBeenCalledWith('/ghl/oauth/billing/callback', { params: {} });
  });
});
