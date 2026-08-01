import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApiKeysService } from './api-keys.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppRole } from '../auth/app-role.enum';
import { assertNoCycle } from './cycle-check';
import { verifyApiKeyHash } from './api-key-hash.util';

describe('ApiKeysService', () => {
  let service: ApiKeysService;

  const mockPrisma = {
    apiKey: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeysService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    service = module.get<ApiKeysService>(ApiKeysService);
  });

  it('creates a key and returns raw apiKey once', async () => {
    mockPrisma.apiKey.create.mockResolvedValue({
      id: 'k1',
      role: AppRole.operator,
      ngoId: null,
      description: 'test',
      createdAt: new Date(),
      lastUsedAt: null,
      createdBy: 'env:API_KEY',
      revokedAt: null,
      revokedBy: null,
      revokedReason: null,
      replacedById: null,
      keyPreview: 's2s_ab...cdef',
    });

    const result = await service.create(
      { role: AppRole.operator, description: 'test' },
      { authType: 'envApiKey' },
    );

    expect(result.id).toBe('k1');
    expect(result.apiKey).toMatch(/^s2s_/);
    const createCall = mockPrisma.apiKey.create.mock.calls[0][0];
    expect(createCall.data.keyHash).toMatch(/^\$argon2id\$/);
    await expect(
      verifyApiKeyHash(createCall.data.keyHash, result.apiKey),
    ).resolves.toBe(true);
  });

  it('requires ngoId for NGO role', async () => {
    await expect(service.create({ role: AppRole.ngo }, {})).rejects.toThrow(
      BadRequestException,
    );
  });

  it('lists keys without returning raw secrets', async () => {
    mockPrisma.apiKey.findMany.mockResolvedValue([
      { id: 'k1', keyPreview: 's2s_12...abcd', role: AppRole.admin },
    ]);

    const result = await service.list();
    expect(result).toEqual([
      { id: 'k1', keyPreview: 's2s_12...abcd', role: AppRole.admin },
    ]);
    expect((result[0] as any).apiKey).toBeUndefined();
  });

  describe('revoke', () => {
    it('throws NotFound if id missing', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue(null);
      await expect(service.revoke('missing', undefined, {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('updates revocation metadata', async () => {
      mockPrisma.apiKey.findUnique.mockResolvedValue({
        id: 'k1',
        revokedAt: null,
      });
      mockPrisma.apiKey.update.mockResolvedValue({
        id: 'k1',
        revokedAt: new Date(),
      });

      await service.revoke('k1', 'compromised', { apiKeyId: 'actor-1' });

      expect(mockPrisma.apiKey.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'k1' },
          data: expect.objectContaining({
            revokedAt: expect.any(Date),
            revokedBy: 'actor-1',
            revokedReason: 'compromised',
          }),
        }),
      );
    });
  });

  describe('rotate', () => {
    it('throws NotFound if key missing', async () => {
      mockPrisma.$transaction.mockImplementation((fn: any) =>
        fn({
          apiKey: {
            findUnique: jest.fn().mockResolvedValue(null),
          },
        }),
      );

      await expect(service.rotate('missing', {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects rotation of revoked keys', async () => {
      mockPrisma.$transaction.mockImplementation((fn: any) =>
        fn({
          apiKey: {
            findUnique: jest.fn().mockResolvedValue({
              id: 'k1',
              role: AppRole.admin,
              ngoId: null,
              description: null,
              revokedAt: new Date(),
            }),
          },
        }),
      );

      await expect(service.rotate('k1', {})).rejects.toThrow(
        BadRequestException,
      );
    });

    it('creates a replacement and revokes the old key (rotation chain)', async () => {
      const tx = {
        apiKey: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'old',
            role: AppRole.operator,
            ngoId: null,
            description: 'worker',
            revokedAt: null,
          }),
          create: jest.fn().mockResolvedValue({
            id: 'new',
            role: AppRole.operator,
            ngoId: null,
            description: 'worker',
            createdAt: new Date(),
            lastUsedAt: null,
            createdBy: 'actor-1',
            revokedAt: null,
            revokedBy: null,
            revokedReason: null,
            replacedById: null,
            keyPreview: 's2s_xx...yyyy',
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      };

      mockPrisma.$transaction.mockImplementation((fn: any) => fn(tx));

      const result = await service.rotate('old', { apiKeyId: 'actor-1' });

      expect(result.replacement.id).toBe('new');
      expect(result.apiKey).toMatch(/^s2s_/);
      const createCall = tx.apiKey.create.mock.calls[0][0];
      expect(createCall.data.keyHash).toMatch(/^\$argon2id\$/);
      await expect(
        verifyApiKeyHash(createCall.data.keyHash, result.apiKey),
      ).resolves.toBe(true);
      expect(tx.apiKey.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'old' },
          data: expect.objectContaining({
            revokedAt: expect.any(Date),
            revokedReason: 'rotated',
            replacedById: 'new',
          }),
        }),
      );
    });
  });

  describe('assertNoCycle', () => {
    it('rejects a 2-node cycle', async () => {
      const mockFindUnique = jest.fn((args: { where: { id: string } }) => {
        if (args.where.id === 'A') return Promise.resolve({ replacedById: 'B' });
        if (args.where.id === 'B') return Promise.resolve({ replacedById: null });
        return Promise.resolve(null);
      });

      const mockPrisma = {
        apiKey: { findUnique: mockFindUnique },
      };

      await expect(
        assertNoCycle('B', 'A', mockPrisma as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('passes when no cycle exists', async () => {
      const mockFindUnique = jest.fn((args: { where: { id: string } }) => {
        if (args.where.id === 'B') return Promise.resolve({ replacedById: null });
        return Promise.resolve(null);
      });

      const mockPrisma = {
        apiKey: { findUnique: mockFindUnique },
      };

      await expect(
        assertNoCycle('A', 'B', mockPrisma as any),
      ).resolves.toBeUndefined();
    });

    it('rejects a chain that already contains a cycle in the database', async () => {
      const mockFindUnique = jest.fn((args: { where: { id: string } }) => {
        if (args.where.id === 'X') return Promise.resolve({ replacedById: 'Y' });
        if (args.where.id === 'Y') return Promise.resolve({ replacedById: 'Z' });
        if (args.where.id === 'Z') return Promise.resolve({ replacedById: 'X' });
        return Promise.resolve(null);
      });

      const mockPrisma = {
        apiKey: { findUnique: mockFindUnique },
      };

      await expect(
        assertNoCycle('newKey', 'X', mockPrisma as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFound if a key in the chain is missing', async () => {
      const mockFindUnique = jest.fn().mockResolvedValue(null);

      const mockPrisma = {
        apiKey: { findUnique: mockFindUnique },
      };

      await expect(
        assertNoCycle('A', 'missing', mockPrisma as any),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
