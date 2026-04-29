import { Type } from 'class-transformer';
import { Allow, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

export interface AttributionSource {
  medium?: string;
  [key: string]: unknown;
}

export interface ContactInfo {
  attributionSource?: AttributionSource;
  lastAttributionSource?: AttributionSource;
  [key: string]: unknown;
}

class CustomDataDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  message?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  channel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  agent_id?: string;
}

class MessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  body?: string;

  @Allow()
  type?: string | number;
}

/**
 * Webhook payload contract.
 *
 * `contact_id` is required because the worker debounces and forwards by
 * (agent_id, contact_id). `agent_id` is read from the top level if present,
 * otherwise from `customData.agent_id` (the location GHL Workflows use).
 * `message.body` (or `customData.message` as a fallback) carries the user
 * text. The validation pipe is configured with `whitelist: true` and
 * `forbidNonWhitelisted: false`, so any extra fields GHL sends pass through
 * silently — they are stripped from the validated instance and never reach
 * the service layer.
 */
export class WebhookPayloadDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  agent_id?: string;

  @IsString()
  @MaxLength(64)
  contact_id!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MessageDto)
  message?: MessageDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CustomDataDto)
  customData?: CustomDataDto;

  @IsOptional()
  @IsObject()
  contact?: ContactInfo;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  event?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  id?: string;

  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}
