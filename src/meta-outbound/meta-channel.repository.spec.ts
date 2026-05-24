import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { AppEnv } from '../config/env.validation';
import { TokenCipher } from '../common/crypto/token-cipher';
import { MetaChannel } from './entities/meta-channel.entity';
import { MetaChannelRepository } from './meta-channel.repository';

const KEY_B64 = Buffer.alloc(32, 9).toString('base64');

function makeCipher(): TokenCipher {
  return new TokenCipher({ get: () => KEY_B64 } as unknown as ConfigService<AppEnv, true>);
}

type RepoMock = {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
  delete: jest.Mock;
};

function makeSut(): { sut: MetaChannelRepository; repo: RepoMock; cipher: TokenCipher } {
  const cipher = makeCipher();
  const repo: RepoMock = {
    findOne: jest.fn(),
    // TypeORM's create() just builds a plain object from the partial.
    create: jest.fn((partial) => ({ ...partial })),
    save: jest.fn(),
    find: jest.fn(),
    delete: jest.fn(),
  };
  const sut = new MetaChannelRepository(repo as unknown as Repository<MetaChannel>, cipher);
  return { sut, repo, cipher };
}

function makeEntity(overrides: Partial<MetaChannel> = {}): MetaChannel {
  return {
    id: 'id-1',
    tenantKey: 'wa:123',
    channel: 'whatsapp',
    phoneNumberId: '123',
    wabaId: null,
    displayPhoneNumber: null,
    accessTokenEnc: 'placeholder',
    graphApiVersion: null,
    locationId: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('MetaChannelRepository', () => {
  describe('findByPhoneNumberId', () => {
    it('returns credentials with the token decrypted', async () => {
      const { sut, repo, cipher } = makeSut();
      repo.findOne.mockResolvedValue(
        makeEntity({ accessTokenEnc: cipher.encrypt('SECRET-TOKEN'), wabaId: 'waba-1' }),
      );

      const creds = await sut.findByPhoneNumberId('123');

      expect(repo.findOne).toHaveBeenCalledWith({ where: { phoneNumberId: '123' } });
      expect(creds?.accessToken).toBe('SECRET-TOKEN');
      expect(creds?.phoneNumberId).toBe('123');
      expect(creds?.wabaId).toBe('waba-1');
      // The decrypted shape must never expose the ciphertext column.
      expect(creds).not.toHaveProperty('accessTokenEnc');
    });

    it('returns null when no row matches', async () => {
      const { sut, repo } = makeSut();
      repo.findOne.mockResolvedValue(null);
      expect(await sut.findByPhoneNumberId('nope')).toBeNull();
    });

    it('throws (without leaking ciphertext) when the token cannot be decrypted', async () => {
      const { sut, repo } = makeSut();
      repo.findOne.mockResolvedValue(makeEntity({ accessTokenEnc: 'v1:bad:bad:bad' }));
      await expect(sut.findByPhoneNumberId('123')).rejects.toThrow(/Failed to decrypt/);
    });
  });

  describe('findByTenantKey', () => {
    it('looks up by tenant_key and decrypts', async () => {
      const { sut, repo, cipher } = makeSut();
      repo.findOne.mockResolvedValue(makeEntity({ accessTokenEnc: cipher.encrypt('T') }));

      const creds = await sut.findByTenantKey('wa:123');

      expect(repo.findOne).toHaveBeenCalledWith({ where: { tenantKey: 'wa:123' } });
      expect(creds?.accessToken).toBe('T');
    });
  });

  describe('upsert', () => {
    it('encrypts the token before persisting and returns it decrypted', async () => {
      const { sut, repo } = makeSut();
      repo.findOne.mockResolvedValue(null);
      repo.save.mockImplementation(async (e: MetaChannel) => ({ ...e, id: 'generated' }));

      const creds = await sut.upsert({
        tenantKey: 'wa:999',
        phoneNumberId: '999',
        accessToken: 'PLAINTEXT',
      });

      const savedArg = repo.save.mock.calls[0][0] as MetaChannel;
      expect(savedArg.accessTokenEnc).not.toContain('PLAINTEXT');
      expect(savedArg.accessTokenEnc.startsWith('v1:')).toBe(true);
      expect(savedArg.channel).toBe('whatsapp');
      expect(savedArg.status).toBe('active');
      expect(creds.accessToken).toBe('PLAINTEXT');
      expect(creds.phoneNumberId).toBe('999');
    });

    it('preserves existing fields not provided in the update', async () => {
      const { sut, repo } = makeSut();
      repo.findOne.mockResolvedValue(
        makeEntity({ phoneNumberId: '999', wabaId: 'keep-me', status: 'disabled' }),
      );
      repo.save.mockImplementation(async (e: MetaChannel) => e);

      await sut.upsert({ tenantKey: 'wa:999', phoneNumberId: '999', accessToken: 'NEW' });

      const savedArg = repo.save.mock.calls[0][0] as MetaChannel;
      expect(savedArg.wabaId).toBe('keep-me');
      expect(savedArg.status).toBe('disabled');
    });
  });

  describe('list / findSummary (token-free, never decrypts)', () => {
    it('lists summaries without the token and without decrypting', async () => {
      const { sut, repo, cipher } = makeSut();
      const decrypt = jest.spyOn(cipher, 'decrypt');
      repo.find.mockResolvedValue([makeEntity({ accessTokenEnc: 'whatever-ciphertext' })]);

      const summaries = await sut.list();

      expect(summaries).toHaveLength(1);
      expect(summaries[0]).not.toHaveProperty('accessToken');
      expect(summaries[0]).not.toHaveProperty('accessTokenEnc');
      expect(summaries[0].phoneNumberId).toBe('123');
      expect(decrypt).not.toHaveBeenCalled();
    });

    it('findSummaryByPhoneNumberId returns null when missing', async () => {
      const { sut, repo } = makeSut();
      repo.findOne.mockResolvedValue(null);
      expect(await sut.findSummaryByPhoneNumberId('nope')).toBeNull();
    });
  });

  describe('findPhoneNumberIdByLocationId (1:1 routing, no decrypt)', () => {
    it('returns the phone_number_id mapped to a location', async () => {
      const { sut, repo, cipher } = makeSut();
      const decrypt = jest.spyOn(cipher, 'decrypt');
      repo.findOne.mockResolvedValue(makeEntity({ phoneNumberId: '555', locationId: 'loc-9' }));

      expect(await sut.findPhoneNumberIdByLocationId('loc-9')).toBe('555');
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { locationId: 'loc-9' },
        select: { id: true, phoneNumberId: true },
      });
      expect(decrypt).not.toHaveBeenCalled();
    });

    it('returns null when no channel maps to the location', async () => {
      const { sut, repo } = makeSut();
      repo.findOne.mockResolvedValue(null);
      expect(await sut.findPhoneNumberIdByLocationId('nope')).toBeNull();
    });
  });

  describe('deleteByPhoneNumberId', () => {
    it('returns true when a row was affected', async () => {
      const { sut, repo } = makeSut();
      repo.delete.mockResolvedValue({ affected: 1 });
      expect(await sut.deleteByPhoneNumberId('123')).toBe(true);
      expect(repo.delete).toHaveBeenCalledWith({ phoneNumberId: '123' });
    });

    it('returns false when nothing matched', async () => {
      const { sut, repo } = makeSut();
      repo.delete.mockResolvedValue({ affected: 0 });
      expect(await sut.deleteByPhoneNumberId('nope')).toBe(false);
    });
  });
});
