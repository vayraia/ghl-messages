import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Request contract for `POST /v1/meta-channels` (admin upsert).
 *
 * `tenantKey` is NOT accepted — it is derived as `wa:<phoneNumberId>` to stay
 * consistent with the inbound webhook keying and avoid caller mistakes.
 */
export class CreateMetaChannelDto {
  @IsString()
  @MaxLength(64)
  phoneNumberId!: string;

  /** Plaintext Graph API access token — encrypted at rest by the repository. */
  @IsString()
  @MaxLength(4096)
  accessToken!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  channel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  wabaId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  displayPhoneNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  graphApiVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  locationId?: string;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';
}
