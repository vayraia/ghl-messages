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

/**
 * A channel WITHOUT the access token — the safe shape for admin read APIs.
 * The token is a secret and must never be returned over the wire.
 */
export interface MetaChannelSummary {
  id: string;
  tenantKey: string;
  channel: string;
  phoneNumberId: string;
  wabaId: string | null;
  displayPhoneNumber: string | null;
  graphApiVersion: string | null;
  locationId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
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
   * Resolves a GHL `location_id` to its WhatsApp `phone_number_id` (1:1). Does
   * NOT decrypt the token — it only routes the send to the right tenant; the
   * worker fetches the credentials by phone_number_id afterwards.
   */
  async findPhoneNumberIdByLocationId(locationId: string): Promise<string | null> {
    const entity = await this.repo.findOne({
      where: { locationId },
      select: { id: true, phoneNumberId: true },
    });
    return entity ? entity.phoneNumberId : null;
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

  /** All channels, token omitted. Never decrypts. */
  async list(): Promise<MetaChannelSummary[]> {
    const rows = await this.repo.find({ order: { createdAt: 'ASC' } });
    return rows.map((e) => toSummary(e));
  }

  /** A single channel by phone_number_id, token omitted. */
  async findSummaryByPhoneNumberId(phoneNumberId: string): Promise<MetaChannelSummary | null> {
    const entity = await this.repo.findOne({ where: { phoneNumberId } });
    return entity ? toSummary(entity) : null;
  }

  /** Deletes a channel by phone_number_id. Returns false if nothing matched. */
  async deleteByPhoneNumberId(phoneNumberId: string): Promise<boolean> {
    const result = await this.repo.delete({ phoneNumberId });
    return (result.affected ?? 0) > 0;
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

function toSummary(entity: MetaChannel): MetaChannelSummary {
  return {
    id: entity.id,
    tenantKey: entity.tenantKey,
    channel: entity.channel,
    phoneNumberId: entity.phoneNumberId,
    wabaId: entity.wabaId,
    displayPhoneNumber: entity.displayPhoneNumber,
    graphApiVersion: entity.graphApiVersion,
    locationId: entity.locationId,
    status: entity.status,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
}
