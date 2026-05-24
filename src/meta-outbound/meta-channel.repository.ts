import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TokenCipher } from '../common/crypto/token-cipher';
import { MetaChannel, MetaChannelStatus } from './entities/meta-channel.entity';

/**
 * A tenant's send credentials with the access token already DECRYPTED. This is
 * the shape callers consume — the encrypted column never leaves the repository.
 */
export interface MetaChannelCredentials {
  id: string;
  tenantKey: string;
  channel: string;
  phoneNumberId: string;
  wabaId: string | null;
  displayPhoneNumber: string | null;
  accessToken: string;
  graphApiVersion: string | null;
  locationId: string | null;
  status: string;
}

export interface UpsertMetaChannelInput {
  tenantKey: string;
  phoneNumberId: string;
  /** Plaintext token — encrypted before it touches the database. */
  accessToken: string;
  channel?: string;
  wabaId?: string | null;
  displayPhoneNumber?: string | null;
  graphApiVersion?: string | null;
  locationId?: string | null;
  status?: MetaChannelStatus;
}

/**
 * Data-access for {@link MetaChannel}, owning the encryption boundary: tokens
 * are encrypted on write and decrypted on read so no other layer handles the
 * ciphertext or the plaintext-at-rest concern.
 *
 * Lookups are by `phone_number_id` (the WhatsApp send target's tenant) or by
 * `tenant_key` (`wa:<phone_number_id>`, matching the inbound webhook keying).
 */
@Injectable()
export class MetaChannelRepository {
  constructor(
    @InjectRepository(MetaChannel) private readonly repo: Repository<MetaChannel>,
    private readonly cipher: TokenCipher,
  ) {}

  async findByPhoneNumberId(phoneNumberId: string): Promise<MetaChannelCredentials | null> {
    const entity = await this.repo.findOne({ where: { phoneNumberId } });
    return entity ? this.toCredentials(entity) : null;
  }

  async findByTenantKey(tenantKey: string): Promise<MetaChannelCredentials | null> {
    const entity = await this.repo.findOne({ where: { tenantKey } });
    return entity ? this.toCredentials(entity) : null;
  }

  /**
   * Inserts or updates a channel keyed by `phone_number_id`. Intended for
   * seeding / admin tooling (no public endpoint owns this yet). The token is
   * encrypted here; callers pass plaintext.
   */
  async upsert(input: UpsertMetaChannelInput): Promise<MetaChannelCredentials> {
    const existing = await this.repo.findOne({
      where: { phoneNumberId: input.phoneNumberId },
    });

    const entity = this.repo.create({
      ...existing,
      tenantKey: input.tenantKey,
      phoneNumberId: input.phoneNumberId,
      accessTokenEnc: this.cipher.encrypt(input.accessToken),
      channel: input.channel ?? existing?.channel ?? 'whatsapp',
      wabaId: input.wabaId ?? existing?.wabaId ?? null,
      displayPhoneNumber: input.displayPhoneNumber ?? existing?.displayPhoneNumber ?? null,
      graphApiVersion: input.graphApiVersion ?? existing?.graphApiVersion ?? null,
      locationId: input.locationId ?? existing?.locationId ?? null,
      status: input.status ?? (existing?.status as MetaChannelStatus | undefined) ?? 'active',
    });

    const saved = await this.repo.save(entity);
    return this.toCredentials(saved);
  }

  private toCredentials(entity: MetaChannel): MetaChannelCredentials {
    let accessToken: string;
    try {
      accessToken = this.cipher.decrypt(entity.accessTokenEnc);
    } catch (err) {
      // A decrypt failure means a corrupt row or a rotated/wrong key — never a
      // recoverable condition. Surface it without leaking the ciphertext.
      throw new Error(
        `Failed to decrypt access token for meta_channel ${entity.id} ` +
          `(phone_number_id=${entity.phoneNumberId}): ${(err as Error).message}`,
      );
    }

    return {
      id: entity.id,
      tenantKey: entity.tenantKey,
      channel: entity.channel,
      phoneNumberId: entity.phoneNumberId,
      wabaId: entity.wabaId,
      displayPhoneNumber: entity.displayPhoneNumber,
      accessToken,
      graphApiVersion: entity.graphApiVersion,
      locationId: entity.locationId,
      status: entity.status,
    };
  }
}
