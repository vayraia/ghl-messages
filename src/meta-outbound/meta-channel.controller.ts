import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WebhookSecretGuard } from '../webhook/guards/webhook-secret.guard';
import { CreateMetaChannelDto } from './dto/create-meta-channel.dto';
import { MetaChannelAdminService } from './meta-channel-admin.service';
import { MetaChannelSummary } from './meta-channel.repository';

/**
 * Admin CRUD for tenant WhatsApp Cloud credentials. Same `x-webhook-secret`
 * auth as the rest of the service. Responses never include the access token.
 */
@Controller({ path: 'meta-channels', version: ['1'] })
@UseGuards(WebhookSecretGuard)
export class MetaChannelController {
  constructor(private readonly admin: MetaChannelAdminService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateMetaChannelDto): Promise<MetaChannelSummary> {
    return this.admin.create(dto);
  }

  @Get()
  list(): Promise<MetaChannelSummary[]> {
    return this.admin.list();
  }

  @Get(':phoneNumberId')
  get(@Param('phoneNumberId') phoneNumberId: string): Promise<MetaChannelSummary> {
    return this.admin.get(phoneNumberId);
  }

  @Delete(':phoneNumberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('phoneNumberId') phoneNumberId: string): Promise<void> {
    return this.admin.remove(phoneNumberId);
  }
}
