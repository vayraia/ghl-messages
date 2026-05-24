import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreateMetaChannelDto } from './dto/create-meta-channel.dto';
import { MetaChannelRepository, MetaChannelSummary } from './meta-channel.repository';

/**
 * Admin operations over the tenant credential store. Returns token-free
 * summaries only — the access token is write-only from the API's perspective
 * (set on create, never read back).
 */
@Injectable()
export class MetaChannelAdminService {
  private readonly logger = new Logger(MetaChannelAdminService.name);

  constructor(private readonly repo: MetaChannelRepository) {}

  async create(dto: CreateMetaChannelDto): Promise<MetaChannelSummary> {
    await this.repo.upsert({
      tenantKey: `wa:${dto.phoneNumberId}`,
      phoneNumberId: dto.phoneNumberId,
      accessToken: dto.accessToken,
      channel: dto.channel,
      wabaId: dto.wabaId,
      displayPhoneNumber: dto.displayPhoneNumber,
      graphApiVersion: dto.graphApiVersion,
      locationId: dto.locationId,
      status: dto.status,
    });

    // Re-read so the response carries timestamps and never the token.
    const summary = await this.repo.findSummaryByPhoneNumberId(dto.phoneNumberId);
    if (!summary) {
      throw new Error(`meta_channel ${dto.phoneNumberId} missing immediately after upsert`);
    }
    this.logger.log(
      { phoneNumberId: summary.phoneNumberId, status: summary.status },
      'meta_channel upserted',
    );
    return summary;
  }

  list(): Promise<MetaChannelSummary[]> {
    return this.repo.list();
  }

  async get(phoneNumberId: string): Promise<MetaChannelSummary> {
    const summary = await this.repo.findSummaryByPhoneNumberId(phoneNumberId);
    if (!summary) {
      throw new NotFoundException(`No meta_channel for phone_number_id=${phoneNumberId}`);
    }
    return summary;
  }

  async remove(phoneNumberId: string): Promise<void> {
    const deleted = await this.repo.deleteByPhoneNumberId(phoneNumberId);
    if (!deleted) {
      throw new NotFoundException(`No meta_channel for phone_number_id=${phoneNumberId}`);
    }
    this.logger.log({ phoneNumberId }, 'meta_channel deleted');
  }
}
