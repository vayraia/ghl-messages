import { NotFoundException } from '@nestjs/common';
import { CreateMetaChannelDto } from './dto/create-meta-channel.dto';
import { MetaChannelAdminService } from './meta-channel-admin.service';
import { MetaChannelRepository, MetaChannelSummary } from './meta-channel.repository';

function makeSut() {
  const repo = {
    upsert: jest.fn(),
    findSummaryByPhoneNumberId: jest.fn(),
    list: jest.fn(),
    deleteByPhoneNumberId: jest.fn(),
  };
  const sut = new MetaChannelAdminService(repo as unknown as MetaChannelRepository);
  return { sut, repo };
}

const summary: MetaChannelSummary = {
  id: 'id-1',
  tenantKey: 'wa:123',
  channel: 'whatsapp',
  phoneNumberId: '123',
  wabaId: null,
  displayPhoneNumber: null,
  graphApiVersion: null,
  locationId: null,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('MetaChannelAdminService', () => {
  describe('create', () => {
    it('derives tenantKey from phoneNumberId, upserts, and returns a token-free summary', async () => {
      const { sut, repo } = makeSut();
      repo.findSummaryByPhoneNumberId.mockResolvedValue(summary);

      const dto: CreateMetaChannelDto = { phoneNumberId: '123', accessToken: 'SECRET' };
      const result = await sut.create(dto);

      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantKey: 'wa:123',
          phoneNumberId: '123',
          accessToken: 'SECRET',
        }),
      );
      expect(result).toBe(summary);
      expect(result).not.toHaveProperty('accessToken');
    });
  });

  describe('get', () => {
    it('returns the summary when found', async () => {
      const { sut, repo } = makeSut();
      repo.findSummaryByPhoneNumberId.mockResolvedValue(summary);
      expect(await sut.get('123')).toBe(summary);
    });

    it('throws NotFound when missing', async () => {
      const { sut, repo } = makeSut();
      repo.findSummaryByPhoneNumberId.mockResolvedValue(null);
      await expect(sut.get('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('resolves when a row was deleted', async () => {
      const { sut, repo } = makeSut();
      repo.deleteByPhoneNumberId.mockResolvedValue(true);
      await expect(sut.remove('123')).resolves.toBeUndefined();
    });

    it('throws NotFound when nothing was deleted', async () => {
      const { sut, repo } = makeSut();
      repo.deleteByPhoneNumberId.mockResolvedValue(false);
      await expect(sut.remove('nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list', () => {
    it('delegates to the repository', async () => {
      const { sut, repo } = makeSut();
      repo.list.mockResolvedValue([summary]);
      expect(await sut.list()).toEqual([summary]);
    });
  });
});
