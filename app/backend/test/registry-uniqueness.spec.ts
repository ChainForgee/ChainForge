import { PrismaClient } from '@prisma/client';

describe('Registry externalId uniqueness scoped to provider', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean up registry tables
    await prisma.registryOrganization.deleteMany();
    await prisma.registryLocation.deleteMany();
    await prisma.registryAsset.deleteMany();
    await prisma.registryProject.deleteMany();
  });

  it('accepts seeding two organizations with the same externalId from different providers', async () => {
    const org1 = await prisma.registryOrganization.create({
      data: {
        registryId: 'ORG-001',
        name: 'Org One',
        externalId: 'ext-123',
        provider: 'provider-A',
      },
    });

    const org2 = await prisma.registryOrganization.create({
      data: {
        registryId: 'ORG-002',
        name: 'Org Two',
        externalId: 'ext-123',
        provider: 'provider-B',
      },
    });

    expect(org1.id).toBeDefined();
    expect(org2.id).toBeDefined();
  });

  it('rejects seeding two organizations with the same externalId from the same provider', async () => {
    await prisma.registryOrganization.create({
      data: {
        registryId: 'ORG-001',
        name: 'Org One',
        externalId: 'ext-123',
        provider: 'provider-A',
      },
    });

    await expect(
      prisma.registryOrganization.create({
        data: {
          registryId: 'ORG-002',
          name: 'Org Two',
          externalId: 'ext-123',
          provider: 'provider-A',
        },
      })
    ).rejects.toThrow();
  });

  it('verifies the uniqueness constraint on other registry models (Location, Asset, Project)', async () => {
    // Location
    await prisma.registryLocation.create({
      data: {
        registryId: 'LOC-001',
        name: 'Loc One',
        externalId: 'loc-123',
        provider: 'provider-A',
      },
    });
    await expect(
      prisma.registryLocation.create({
        data: {
          registryId: 'LOC-002',
          name: 'Loc Two',
          externalId: 'loc-123',
          provider: 'provider-A',
        },
      })
    ).rejects.toThrow();

    // Asset
    await prisma.registryAsset.create({
      data: {
        registryId: 'AST-001',
        name: 'Asset One',
        externalId: 'ast-123',
        provider: 'provider-A',
      },
    });
    await expect(
      prisma.registryAsset.create({
        data: {
          registryId: 'AST-002',
          name: 'Asset Two',
          externalId: 'ast-123',
          provider: 'provider-A',
        },
      })
    ).rejects.toThrow();

    // Project
    await prisma.registryProject.create({
      data: {
        registryId: 'PRJ-001',
        name: 'Project One',
        externalId: 'prj-123',
        provider: 'provider-A',
      },
    });
    await expect(
      prisma.registryProject.create({
        data: {
          registryId: 'PRJ-002',
          name: 'Project Two',
          externalId: 'prj-123',
          provider: 'provider-A',
        },
      })
    ).rejects.toThrow();
  });
});
