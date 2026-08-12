import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Payload contract for `POST /webhook/outbound`.
 *
 * GHL fires this webhook for every outgoing message. The (currently disabled)
 * legacy handler only acted when `type === "OutboundMessage"` AND
 * `status === "delivered"` AND `userId` is present (a human agent replied —
 * not the bot). All other shapes are silently acknowledged with 200.
 *
 * `body` is declared so it survives the global `whitelist: true` validation
 * pipe — it's the outgoing message text, used by the stop_message tag match.
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

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  body?: string;
}
