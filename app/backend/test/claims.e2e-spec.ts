import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { AppModule } from 'src/app.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { EncryptionService } from 'src/common/encryption/encryption.service';
import { BudgetService } from 'src/common/budget/budget.service';
import request from 'supertest';
import { App } from 'supertest/types';

const STELLAR_ADDR = 'GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ5LKG3FZTSZ3NYNEJBBENSN';

type ClaimDto = {
  id: string;
  status: string;
  campaignId: string;
  amount: number;
  recipientRef: string;
  evidenceRef?: string;
  campaign: { id: string; name: string };
};

describe('Claims (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let encryptionService: EncryptionService;

  const base = '/api/v1/claims';
  const testApiKey = 'e2e-test-key-0002';
  const testApiKeyHash = '0ddfd56b80b5f63187c748e910d5ae632669a46f221170bdcbb04989e44d107a';
  const authHeader = { 'X-Api-Key': testApiKey } as Record<string, string>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      providers: [BudgetService, PrismaService],
    }).compile();

    app = moduleRef.createNestApplication();

    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
      prefix: 'v',
    });

    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );

    await app.init();
    prisma = app.get(PrismaService);
    encryptionService = app.get(EncryptionService);

    await prisma.apiKey.upsert({
      where: { keyHash: testApiKeyHash },
      update: { revokedAt: null },
      create: {
        key: testApiKey,
        keyHash: testApiKeyHash,
        keyPreview: testApiKey.slice(0, 8),
        role: 'admin',
      },
    });
  });

  beforeEach(async () => {
    await prisma.balanceLedger.deleteMany();
    await prisma.claim.deleteMany();
    await prisma.campaign.deleteMany();
  });

  afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { keyHash: testApiKeyHash } });
    await app.close();
  });

  it('POST /claims creates a claim', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });

    const res = await request(app.getHttpServer())
      .post(base)
      .set(authHeader)
      .send({
        campaignId: campaign.id,
        amount: 100.5,
        recipientRef: 'recipient-123',
        evidenceRef: 'evidence-456',
        tokenAddress: STELLAR_ADDR,
      })
      .expect(201);

    const body = res.body as ClaimDto;
    expect(body.status).toBe('requested');
    expect(body.amount).toBe(100.5);
    expect(body.recipientRef).toBe('recipient-123');
    expect(body.evidenceRef).toBe('evidence-456');
    expect(body.campaign.id).toBe(campaign.id);
  });

  it('POST /claims rejects invalid campaignId', async () => {
    await request(app.getHttpServer())
      .post(base)
      .set(authHeader)
      .send({ campaignId: 'invalid-id', amount: 100.5, recipientRef: 'recipient-123', tokenAddress: STELLAR_ADDR })
      .expect(404);
  });

  it('GET /claims returns all claims', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });
    await prisma.claim.create({
      data: { campaignId: campaign.id, amount: 50, recipientRef: encryptionService.encrypt('recipient-1') },
    });

    const res = await request(app.getHttpServer()).get(base).set(authHeader).expect(200);
    const body = res.body as ClaimDto[];
    expect(body).toHaveLength(1);
  });

  it('GET /claims/:id returns claim details', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });
    const claim = await prisma.claim.create({
      data: { campaignId: campaign.id, amount: 50, recipientRef: encryptionService.encrypt('recipient-1') },
    });

    const res = await request(app.getHttpServer())
      .get(`${base}/${claim.id}`)
      .set(authHeader)
      .expect(200);

    const body = res.body as ClaimDto;
    expect(body.id).toBe(claim.id);
    expect(body.status).toBe('requested');
  });

  it('POST /claims/:id/verify transitions requested to verified', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });
    const claim = await prisma.claim.create({
      data: { campaignId: campaign.id, amount: 50, recipientRef: encryptionService.encrypt('recipient-1') },
    });

    const res = await request(app.getHttpServer())
      .post(`${base}/${claim.id}/verify`)
      .set(authHeader)
      .expect(201);

    const body = res.body as ClaimDto;
    expect(body.status).toBe('verified');
  });

  it('POST /claims/:id/approve transitions verified to approved', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });
    const claim = await prisma.claim.create({
      data: { campaignId: campaign.id, amount: 50, recipientRef: encryptionService.encrypt('recipient-1'), status: 'verified' },
    });

    const res = await request(app.getHttpServer())
      .post(`${base}/${claim.id}/approve`)
      .set(authHeader)
      .expect(201);

    const body = res.body as ClaimDto;
    expect(body.status).toBe('approved');
  });

  it('POST /claims/:id/disburse transitions approved to disbursed', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });
    const claim = await prisma.claim.create({
      data: { campaignId: campaign.id, amount: 50, recipientRef: encryptionService.encrypt('recipient-1'), status: 'approved' },
    });

    const res = await request(app.getHttpServer())
      .post(`${base}/${claim.id}/disburse`)
      .set(authHeader)
      .expect(201);

    const body = res.body as ClaimDto;
    expect(body.status).toBe('disbursed');
  });

  it('PATCH /claims/:id/archive transitions disbursed to archived', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });
    const claim = await prisma.claim.create({
      data: { campaignId: campaign.id, amount: 50, recipientRef: encryptionService.encrypt('recipient-1'), status: 'disbursed' },
    });

    const res = await request(app.getHttpServer())
      .patch(`${base}/${claim.id}/archive`)
      .set(authHeader)
      .expect(200);

    const body = res.body as ClaimDto;
    expect(body.status).toBe('archived');
  });

  it('POST /claims/:id/verify rejects invalid transition', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });
    const claim = await prisma.claim.create({
      data: { campaignId: campaign.id, amount: 50, recipientRef: encryptionService.encrypt('recipient-1'), status: 'verified' },
    });

    await request(app.getHttpServer())
      .post(`${base}/${claim.id}/verify`)
      .set(authHeader)
      .expect(400);
  });

  describe('Claims HTTP cache', () => {
    it('GET /claims returns Cache-Control with max-age=30', async () => {
      const campaign = await prisma.campaign.create({
        data: { name: 'Cache Campaign', budget: 1000 },
      });
      await prisma.claim.create({
        data: { campaignId: campaign.id, amount: 50, recipientRef: encryptionService.encrypt('cache-test') },
      });

      const res = await request(app.getHttpServer())
        .get(base)
        .set(authHeader)
        .expect(200);

      const cc = res.headers['cache-control'];
      expect(cc).toBeDefined();
      expect(cc).toContain('max-age=30');
      expect(cc).toContain('private');
    });

    it('second call within TTL returns 304 with X-Edge-Cache-Status: hit', async () => {
      const campaign = await prisma.campaign.create({
        data: { name: '304 Campaign', budget: 1000 },
      });
      await prisma.claim.create({
        data: { campaignId: campaign.id, amount: 25, recipientRef: encryptionService.encrypt('304-test') },
      });

      const res1 = await request(app.getHttpServer())
        .get(base)
        .set(authHeader)
        .expect(200);

      const etag = res1.headers['etag'];
      expect(etag).toBeDefined();

      const res2 = await request(app.getHttpServer())
        .get(base)
        .set(authHeader)
        .set('If-None-Match', etag)
        .expect(304);

      expect(res2.headers['x-edge-cache-status']).toBe('hit');
    });
  });
});
