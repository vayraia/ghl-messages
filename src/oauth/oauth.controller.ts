import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';

@Controller({ path: 'oauth', version: ['1'] })
export class OAuthController {
  @Get('callback')
  @HttpCode(HttpStatus.OK)
  callback(
    @Query('code') code?: string,
    @Query('locationId') locationId?: string,
  ): { ok: true; received: { code: boolean; locationId: boolean } } {
    return {
      ok: true,
      received: {
        code: typeof code === 'string' && code.length > 0,
        locationId: typeof locationId === 'string' && locationId.length > 0,
      },
    };
  }
}
