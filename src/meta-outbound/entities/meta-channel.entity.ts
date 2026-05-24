import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type MetaChannelStatus = 'active' | 'disabled';

/**
 * A connected Meta sending account, keyed the same way as the inbound webhook
 * (`meta-tenant.ts`): `wa:<phone_number_id>` for WhatsApp Cloud. Holds the
 * per-tenant Graph API credentials used to send outbound messages.
 *
 * The access token is stored encrypted (AES-256-GCM) in `access_token_enc` and
 * never as plaintext — encryption/decryption is owned by
 * `MetaChannelRepository` via `TokenCipher`. Schema is managed by migrations
 * (`synchronize` is always off); the decorators here mirror the migration.
 */
@Entity({ name: 'meta_channels' })
export class MetaChannel {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('uq_meta_channels_tenant_key', { unique: true })
  @Column({ name: 'tenant_key', type: 'text' })
  tenantKey!: string;

  @Column({ type: 'text', default: 'whatsapp' })
  channel!: string;

  @Index('uq_meta_channels_phone_number_id', { unique: true })
  @Column({ name: 'phone_number_id', type: 'text' })
  phoneNumberId!: string;

  @Column({ name: 'waba_id', type: 'text', nullable: true })
  wabaId!: string | null;

  @Column({ name: 'display_phone_number', type: 'text', nullable: true })
  displayPhoneNumber!: string | null;

  @Column({ name: 'access_token_enc', type: 'text' })
  accessTokenEnc!: string;

  @Column({ name: 'graph_api_version', type: 'text', nullable: true })
  graphApiVersion!: string | null;

  @Index('idx_meta_channels_location_id')
  @Column({ name: 'location_id', type: 'text', nullable: true })
  locationId!: string | null;

  @Column({ type: 'text', default: 'active' })
  status!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
