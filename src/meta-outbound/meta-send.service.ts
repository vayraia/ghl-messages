import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import { AppEnv } from '../config/env.validation';
import { MetaChannelRepository } from './meta-channel.repository';
import {
  META_OUTBOUND_QUEUE_TOKEN,
  META_OUTBOUND_REDIS_CLIENT,
  META_SEND_JOB,
} from './meta-outbound.constants';
import { SendWhatsAppDto } from './dto/send-whatsapp.dto';
import {
  buildSendBody,
  CloudApiSendBody,
  WaOutboundMessage,
  WaValidationError,
} from './whatsapp-message';

/** Job payload for the outbound send worker. The body is already built and
 * validated at ingress, so the worker only resolves credentials and sends. */
export interface MetaSendJobData {
  phoneNumberId: string;
  body: CloudApiSendBody;
}

export interface MetaSendResult {
  jobId: string;
  deduplicated: boolean;
}

/**
 * Validates an outbound WhatsApp request, dedupes it, and enqueues it.
 *
 * Validation runs first (fail fast → 400, never enqueue a malformed message),
 * then idempotency via Redis `SET NX EX` (same convention as the inbound flow),
 * then the job is added to the `meta-outbound` queue with the shared retry
 * policy. The actual Cloud API call happens in {@link MetaSendProcessor}.
 */
@Injectable()
export class MetaSendService {
  private readonly logger = new Logger(MetaSendService.name);
  private readonly idempotencyTtlSeconds: number;
  private readonly attempts: number;
  private readonly backoffMs: number;

  constructor(
    @InjectQueue(META_OUTBOUND_QUEUE_TOKEN) private readonly queue: Queue<MetaSendJobData>,
    @Inject(META_OUTBOUND_REDIS_CLIENT) private readonly redis: Redis,
    private readonly channels: MetaChannelRepository,
    config: ConfigService<AppEnv, true>,
  ) {
    this.idempotencyTtlSeconds = config.get('IDEMPOTENCY_TTL_SECONDS', { infer: true });
    this.attempts = config.get('META_OUTBOUND_JOB_ATTEMPTS', { infer: true });
    this.backoffMs = config.get('META_OUTBOUND_BACKOFF_MS', { infer: true });
  }

  async enqueue(
    dto: SendWhatsAppDto,
    opts: { idempotencyKey?: string } = {},
  ): Promise<MetaSendResult> {
    const phoneNumberId = await this.resolvePhoneNumberId(dto);

    let body: CloudApiSendBody;
    try {
      body = buildSendBody(dto.to, dto.message as WaOutboundMessage);
    } catch (err) {
      if (err instanceof WaValidationError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    const idempotencyKey = opts.idempotencyKey?.trim() || undefined;
    if (idempotencyKey) {
      const wasFresh = await this.redis.set(
        idempotencyKeyFor(idempotencyKey),
        '1',
        'EX',
        this.idempotencyTtlSeconds,
        'NX',
      );
      if (wasFresh === null) {
        return { jobId: idempotencyKey, deduplicated: true };
      }
    }

    // BullMQ rejects custom job IDs containing ':'.
    const jobId = idempotencyKey
      ? `wa_${idempotencyKey.replace(/:/g, '_')}`
      : `wa_${phoneNumberId}_${Date.now()}-${randomUUID().slice(0, 8)}`;

    await this.queue.add(
      META_SEND_JOB,
      { phoneNumberId, body },
      {
        jobId,
        attempts: this.attempts,
        backoff: { type: 'exponential', delay: this.backoffMs },
        removeOnComplete: true,
        removeOnFail: { age: 86_400 },
      },
    );

    this.logger.log(
      { jobId, phoneNumberId, type: body.type },
      'Outbound WhatsApp message enqueued',
    );
    return { jobId, deduplicated: false };
  }

  /**
   * Resolves the target `phone_number_id`. Provide either `phoneNumberId`
   * (used as-is) or `locationId` (resolved 1:1 via the credential store).
   * `phoneNumberId` wins if both are present.
   */
  private async resolvePhoneNumberId(dto: SendWhatsAppDto): Promise<string> {
    if (dto.phoneNumberId) return dto.phoneNumberId;

    if (dto.locationId) {
      const phoneNumberId = await this.channels.findPhoneNumberIdByLocationId(dto.locationId);
      if (!phoneNumberId) {
        throw new NotFoundException(`No meta_channel registered for locationId=${dto.locationId}`);
      }
      return phoneNumberId;
    }

    throw new BadRequestException('Either phoneNumberId or locationId is required');
  }
}

function idempotencyKeyFor(key: string): string {
  return `meta:outbound:idem:${key}`;
}
