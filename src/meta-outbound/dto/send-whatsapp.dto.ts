import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Request contract for `POST /v1/messages/whatsapp`.
 *
 * The envelope (`phoneNumberId`, `to`, optional `idempotencyKey`) is validated
 * here; `message` is intentionally a loose object — its shape is validated by
 * `buildSendBody` (the single source of truth for Cloud API limits), which the
 * service calls before enqueuing so a malformed message is rejected with 400.
 *
 * Because `message` has no nested `@Type`, the global `whitelist` ValidationPipe
 * leaves its contents untouched (buttons/sections/etc. survive intact).
 */
export class SendWhatsAppDto {
  /** Sender's WhatsApp phone_number_id — selects the tenant credentials. */
  @IsString()
  @MaxLength(64)
  phoneNumberId!: string;

  /** Recipient phone number in international format (digits). */
  @IsString()
  @MaxLength(32)
  to!: string;

  /** Optional dedupe key; may also be supplied via the x-idempotency-key header. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;

  @IsObject()
  message!: Record<string, unknown>;
}
