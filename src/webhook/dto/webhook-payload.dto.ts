import { Type } from 'class-transformer';
import { IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

class AttributionSourceDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  medium?: string;
}

class ContactInfoDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => AttributionSourceDto)
  attributionSource?: AttributionSourceDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AttributionSourceDto)
  lastAttributionSource?: AttributionSourceDto;
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
}

class MessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  type?: string;
}

/**
 * Webhook payload contract.
 *
 * `agent_id` and `contact_id` are required because the worker debounces and
 * forwards by that pair. `message.body` (or `customData.message` as a
 * fallback) carries the user text. Other fields are optional metadata
 * preserved for downstream consumers.
 */
export class WebhookPayloadDto {
  @IsString()
  @MaxLength(64)
  agent_id!: string;

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
  @ValidateNested()
  @Type(() => ContactInfoDto)
  contact?: ContactInfoDto;

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
