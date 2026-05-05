import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Payload contract for `POST /webhook/outbound`.
 *
 * GHL fires this webhook for every outgoing message. The controller only
 * acts when `type === "OutboundMessage"` AND `status === "delivered"` AND
 * `userId` is present (a human agent replied — not the bot). All other
 * shapes are silently acknowledged with 200.
 */
export class OutboundWebhookPayloadDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
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
  @MaxLength(128)
  messageId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  userId?: string;
}
