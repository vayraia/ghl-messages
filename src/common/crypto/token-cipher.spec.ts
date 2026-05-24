import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../../config/env.validation';
import { TokenCipher, decodeKey } from './token-cipher';

// Deterministic 32-byte key for tests (base64). Not a real secret.
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

function makeCipher(keyB64: string = KEY_B64): TokenCipher {
  const config = {
    get: () => keyB64,
  } as unknown as ConfigService<AppEnv, true>;
  return new TokenCipher(config);
}

describe('TokenCipher', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const cipher = makeCipher();
    const secret = 'EAAB...meta-access-token...xyz';
    expect(cipher.decrypt(cipher.encrypt(secret))).toBe(secret);
  });

  it('round-trips unicode and empty strings', () => {
    const cipher = makeCipher();
    for (const value of ['', 'héllo 🌎', 'a'.repeat(2048)]) {
      expect(cipher.decrypt(cipher.encrypt(value))).toBe(value);
    }
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const cipher = makeCipher();
    const a = cipher.encrypt('same-input');
    const b = cipher.encrypt('same-input');
    expect(a).not.toBe(b);
    expect(cipher.decrypt(a)).toBe('same-input');
    expect(cipher.decrypt(b)).toBe('same-input');
  });

  it('emits the versioned v1:iv:tag:ciphertext format', () => {
    const parts = makeCipher().encrypt('x').split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
  });

  it('fails to decrypt when the ciphertext is tampered (GCM auth tag)', () => {
    const cipher = makeCipher();
    const payload = cipher.encrypt('do-not-tamper');
    const parts = payload.split(':');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] ^= 0xff; // flip a byte
    parts[3] = ct.toString('base64');
    expect(() => cipher.decrypt(parts.join(':'))).toThrow();
  });

  it('rejects a malformed payload', () => {
    const cipher = makeCipher();
    expect(() => cipher.decrypt('not-a-valid-payload')).toThrow('Malformed encrypted token');
    expect(() => cipher.decrypt('v2:a:b:c')).toThrow('Malformed encrypted token');
  });

  it('cannot decrypt with a different key', () => {
    const a = makeCipher(Buffer.alloc(32, 1).toString('base64'));
    const b = makeCipher(Buffer.alloc(32, 2).toString('base64'));
    expect(() => b.decrypt(a.encrypt('secret'))).toThrow();
  });

  describe('decodeKey', () => {
    it('accepts a 32-byte base64 key', () => {
      expect(decodeKey(KEY_B64)).toHaveLength(32);
    });

    it('rejects a key that is not 32 bytes', () => {
      expect(() => decodeKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
    });
  });
});
