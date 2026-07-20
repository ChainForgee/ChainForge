import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import request from 'supertest';
import { Prisma } from '@prisma/client';

// Mock external services
jest.mock('@stellar/stellar-sdk', () => ({
  Server: jest.fn().mockImplementation(() => ({
    loadAccount: jest.fn().mockResolvedValue({ id: 'test', sequence: '0' }),
    submitTransaction: jest
      .fn()
      .mockResolvedValue({ hash: '0x123', status: 'SUCCESS' }),
  })),
  Keypair: {
    random: jest.fn().mockReturnValue({ publicKey: () => 'test-key' }),
    fromSecret: jest.fn().mockReturnValue({ publicKey: () => 'test-key' }),
  },
  Networks: { PUBLIC: 'test', TESTNET: 'test' },
  Asset: { native: jest.fn() },
  Operation: { payment: jest.fn(), createAccount: jest.fn() },
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({ toXDR: () => 'xdr', sign: jest.fn() }),
  })),
}));

jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [
            { message: { content: JSON.stringify({ verified: true }) } },
          ],
        }),
      },
    },
  })),
}));

describe('Verification Lifecycle E2E', () => {
  let app: INestApplication;
  let prismaService: PrismaService;
  let moduleFixture: TestingModule;
  let validApiKey: string;
  let testCampaignId: string;
  const createdClaimIds: string[] = [];

  const validStellarAddress =
    'GBXGQJWVLWOYHFLVTKWV5FGHA3JYYV3A7JQKNO6TCTSVL4K3JDLDZBPK';
  const validTokenAddress =
    'GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ5LKG3FZTSZ3NYNEJBBENSN';

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
      prefix: 'v',
    });
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    prismaService = moduleFixture.get<PrismaService>(PrismaService);
    validApiKey = process.env.API_KEY || 'test-api-key-123';

    const apiKeyHash = require('crypto').createHash('sha256').update(validApiKey).digest('hex');
    await prismaService.apiKey.upsert({
      where: { keyHash: apiKeyHash },
      update: { revokedAt: null },
      create: {
        key: validApiKey,
        keyHash: apiKeyHash,
        keyPreview: validApiKey.slice(0, 8),
        role: 'admin',
      },
    });

    // Create a test campaign
    const campaign = await prismaService.campaign.create({
      data: {
        name: `E2E Test Campaign ${Date.now()}`,
        status: 'active',
        budget: 100000,
      },
    });
    testCampaignId = campaign.id;
    console.log('✅ Test campaign created:', testCampaignId);
  });

  afterAll(async () => {
    if (testCampaignId) {
      try {
        await prismaService.auditLog.deleteMany({
          where: { campaignId: testCampaignId },
        });
        await prismaService.balanceLedger.deleteMany({
          where: { campaignId: testCampaignId },
        });
        await prismaService.claim.deleteMany({
          where: { campaignId: testCampaignId },
        });
        await prismaService.campaign.delete({
          where: { id: testCampaignId },
        });
      } catch (_error) {
        // Ignored
      }
    }
    await app.close();
  });

  const base = '/api/v1/claims';

  describe('API Health & Security', () => {
    it('GET /health - should return 200 OK', async () => {
      await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      console.log('✅ Health check passed');
    });

    it('GET /claims - should reject missing API key', async () => {
      await request(app.getHttpServer()).get(base).expect(401);
      console.log('✅ API key protection works');
    });

    it('GET /claims - should accept valid API key', async () => {
      const response = await request(app.getHttpServer())
        .get(base)
        .set('X-API-Key', validApiKey)
        .expect(200);

      expect(Array.isArray(response.body.data.data)).toBe(true);
      console.log('✅ Valid API key accepted');
    });
  });

  describe('Claim Management', () => {
    let createdClaimId: string;

    it('POST /claims - should create a claim with correct fields', async () => {
      const claimData = {
        campaignId: testCampaignId,
        recipientRef: validStellarAddress,
        tokenAddress: validTokenAddress,
        amount: 1000,
      };

      const response = await request(app.getHttpServer())
        .post(base)
        .set('X-API-Key', validApiKey)
        .send(claimData)
        .expect(201);

      const body = response.body.data;
      expect(body).toHaveProperty('id');
      expect(String(body.amount)).toBe(String(1000));

      createdClaimId = body.id;
      createdClaimIds.push(createdClaimId);

      // Verify database state
      const dbClaim = await prismaService.claim.findUnique({
        where: { id: createdClaimId },
      });
      expect(dbClaim).toBeDefined();
      expect(dbClaim?.status).toBe('requested');

      // Verify audit log was created
      const auditLog = await prismaService.auditLog.findFirst({
        where: {
          entityId: createdClaimId,
          entity: 'Claim',
        },
      });
      expect(auditLog).toBeDefined();

      console.log(`✅ Claim created: ${createdClaimId}`);
    });

    it('GET /claims - should list claims', async () => {
      const response = await request(app.getHttpServer())
        .get(base)
        .set('X-API-Key', validApiKey)
        .expect(200);

      expect(Array.isArray(response.body.data.data)).toBe(true);
      console.log(`✅ Retrieved ${response.body.data.data.length} claims`);
    });
  });

  describe('Verification Flow', () => {
    let testClaimId: string;

    it('should create a claim and start verification', async () => {
      // Create claim
      const claimData = {
        campaignId: testCampaignId,
        recipientRef: validStellarAddress,
        tokenAddress: validTokenAddress,
        amount: 500,
      };

      const claimResponse = await request(app.getHttpServer())
        .post(base)
        .set('X-API-Key', validApiKey)
        .send(claimData)
        .expect(201);

      testClaimId = claimResponse.body.data.id;
      createdClaimIds.push(testClaimId);
      console.log(`✅ Test claim created: ${testClaimId}`);

      // Start verification
      const verifyResponse = await request(app.getHttpServer())
        .post(`${base}/${testClaimId}/verify`)
        .set('X-API-Key', validApiKey)
        .send({ method: 'humanitarian' })
        .expect(200);

      const verifyBody = verifyResponse.body.data;
      expect(verifyBody).toHaveProperty('id');
      expect(verifyBody.status).toBe('verified');

      // Verify database state after verification
      const dbClaim = await prismaService.claim.findUnique({
        where: { id: testClaimId },
      });
      expect(dbClaim?.status).toBe('verified');

      // Verify audit log for verification was created
      const auditLog = await prismaService.auditLog.findFirst({
        where: {
          entityId: testClaimId,
          entity: 'Claim',
        },
      });
      expect(auditLog).toBeDefined();

      console.log(
        `✅ Verification completed, claim status: ${verifyBody.status}`,
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle non-existent claim', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      await request(app.getHttpServer())
        .post(`${base}/${nonExistentId}/verify`)
        .set('X-API-Key', validApiKey)
        .send({ method: 'humanitarian' })
        .expect(404);

      console.log('✅ Not found error handled correctly');
    });

    it('should reject invalid API key', async () => {
      await request(app.getHttpServer())
        .get(base)
        .set('X-API-Key', 'invalid-key-12345')
        .expect(401);

      console.log('✅ Invalid API key rejected');
    });
  });

  describe('Module Integration', () => {
    it('should have PrismaService available', () => {
      expect(prismaService).toBeDefined();
      console.log('✅ PrismaService loaded');
    });
  });

  describe('Onchain Disbursement', () => {
    let disbursementClaimId: string;

    it('should create and verify a claim for disbursement test', async () => {
      // Create claim
      const claimData = {
        campaignId: testCampaignId,
        recipientRef: validStellarAddress,
        tokenAddress: validTokenAddress,
        amount: 2000,
      };

      const claimResponse = await request(app.getHttpServer())
        .post(base)
        .set('X-API-Key', validApiKey)
        .send(claimData)
        .expect(201);

      disbursementClaimId = claimResponse.body.data.id;
      createdClaimIds.push(disbursementClaimId);

      // Verify the claim
      await request(app.getHttpServer())
        .post(`${base}/${disbursementClaimId}/verify`)
        .set('X-API-Key', validApiKey)
        .send({ method: 'humanitarian' })
        .expect(200);

      console.log(
        `✅ Verified claim created for disbursement: ${disbursementClaimId}`,
      );
    });
  });

  describe('Onchain Package Creation', () => {
    let verifiedClaimId: string;

    it('should create a verified claim for package testing', async () => {
      // Create a claim
      const claimData = {
        campaignId: testCampaignId,
        recipientRef: validStellarAddress,
        tokenAddress: validTokenAddress,
        amount: 750,
      };

      const claimResponse = await request(app.getHttpServer())
        .post(base)
        .set('X-API-Key', validApiKey)
        .send(claimData)
        .expect(201);

      verifiedClaimId = claimResponse.body.data.id;
      createdClaimIds.push(verifiedClaimId);

      // Verify the claim
      await request(app.getHttpServer())
        .post(`${base}/${verifiedClaimId}/verify`)
        .set('X-API-Key', validApiKey)
        .send({ method: 'humanitarian' })
        .expect(200);

      console.log(
        `✅ Verified claim created for package test: ${verifiedClaimId}`,
      );
    });
  });
});
