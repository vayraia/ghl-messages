import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import type { Response } from 'express';
import { AppEnv } from '../config/env.validation';

const UPSTREAM_PATH = '/ghl/oauth/callback';

const BAD_GATEWAY_PAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>No se pudo completar la instalación</title></head><body><h1>No se pudo completar la instalación</h1><p>Intenta instalar de nuevo.</p></body></html>`;

/**
 * Redirect URL registered in the GHL Marketplace app. GHL sends the browser
 * here after a sub-account authorizes the app.
 *
 * This service does not own the install tokens: the `ai` backend exchanges the
 * authorization `code` for tokens and stores them encrypted per location
 * (`ghl_installations`). So this endpoint only forwards the `code` (or `error`)
 * server-to-server to `CHAT_API_URL/ghl/oauth/callback` and relays that page.
 *
 * The URL GHL calls — and therefore the `redirect_uri` of the token exchange —
 * stays this one, so `ai` must have `GHL_OAUTH_REDIRECT_URI` set to it.
 * The authorization `code` is single-use and sensitive: it is never logged.
 */
@Controller({ path: 'oauth', version: ['1'] })
export class OAuthController {
  private readonly logger = new Logger(OAuthController.name);
  private readonly client: AxiosInstance;

  constructor(config: ConfigService<AppEnv, true>) {
    this.client = axios.create({
      baseURL: config.get('CHAT_API_URL', { infer: true }),
      timeout: config.get('CHAT_API_TIMEOUT_MS', { infer: true }),
      validateStatus: () => true,
      maxRedirects: 0,
      responseType: 'text',
      transformResponse: (data: unknown) => data,
    });
  }

  @Get('callback')
  async callback(
    @Res({ passthrough: true }) res: Response,
    @Query('code') code?: string,
    @Query('error') error?: string,
  ): Promise<string> {
    const params: Record<string, string> = {};
    if (typeof code === 'string' && code.length > 0) params.code = code;
    if (typeof error === 'string' && error.length > 0) params.error = error;

    res.type('html');
    try {
      const upstream = await this.client.get<string>(UPSTREAM_PATH, { params });
      res.status(upstream.status);
      this.logger.log(
        { status: upstream.status, hasCode: 'code' in params },
        'GHL oauth callback forwarded to ai',
      );
      return typeof upstream.data === 'string' ? upstream.data : '';
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'GHL oauth callback forward failed');
      res.status(502);
      return BAD_GATEWAY_PAGE;
    }
  }
}
