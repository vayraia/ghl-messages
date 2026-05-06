import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Native GHL `InboundMessage` webhook payload (the one delivered straight from
 * GHL's standard webhook subscription, not our custom Workflow forwarder).
 *
 * The validation pipe is configured with `whitelist: true` so unknown fields
 * (`from`, `to`, `webhookId`, `dateAdded`, `appId`, `versionId`, etc.) are
 * silently stripped from the validated instance.
 */
export class InboundMessagePayloadDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  direction?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  locationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  contactId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  conversationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  messageId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  messageType?: string;

  @IsOptional()
  @IsNumber()
  messageTypeId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  messageTypeString?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  contentType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  userId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  attachments?: string[];

  @Allow()
  timestamp?: string;
}
