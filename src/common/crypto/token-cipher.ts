import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { AppEnv } from '../../config/env.validation';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce — the recommended size for GCM
const KEY_LENGTH = 32; // 256-bit key
const VERSION = 'v1';

/**
 * Symmetric encryption for secrets at rest (Meta Graph API access tokens).
 *
 * Tokens are long-lived credentials, so they must never sit in the database
 * or logs in plaintext. We use AES-256-GCM, which is authenticated: a tampered
 * ciphertext fails to decrypt rather than returning garbage.
 *
 * The serialized format is `v1:<iv>:<tag>:<ciphertext>`, each part base64.
 * The version prefix lets us rotate the scheme later without ambiguity.
 *
 * The key is a 32-byte value provided base64-encoded via `META_TOKEN_ENC_KEY`.
 * Generate one with: `openssl rand -base64 32`.
 */
@Injectable()
export class TokenCipher {
  private readonly key: Buffer;

  constructor(config: ConfigService<AppEnv, true>) {
    const raw = config.get('META_TOKEN_ENC_KEY', { infer: true });
    if (!raw) {
      throw new Error('META_TOKEN_ENC_KEY is required when META_OUTBOUND_ENABLED=true');
    }
    this.key = decodeKey(raw);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('Malformed encrypted token: unexpected format');
    }
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ciphertext = Buffer.from(parts[3], 'base64');

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

/**
 * Decodes and validates the base64 master key. Exported so the failure is
 * easy to unit test and so callers fail fast at construction time with a
 * clear message instead of deep inside a crypto call.
 */
export function decodeKey(raw: string): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `META_TOKEN_ENC_KEY must decode to ${KEY_LENGTH} bytes (got ${key.length}). ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
  return key;
}
