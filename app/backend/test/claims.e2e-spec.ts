import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import request, { Response as SupertestResponse } from 'supertest';
import { AppModule } from 'src/app.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { BudgetService } from 'src/common/budget/budget.service';
import { App } from 'supertest/types';
import { EncryptionService } from 'src/common/encryption/encryption.service';

type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
};

type ClaimResponseDto = {
  id: string;
  status: string;
  campaignId: string;
  amount: number;
  recipientRef: string;
  evidenceRef?: string;
  campaign: {
    id: string;
    name: string;
  };
};

function bodyAs<T>(res: SupertestResponse): ApiResponse<T> {
  return res.body as ApiResponse<T>;
}

describe('Claims (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let encryptionService: EncryptionService;

  const base = '/api/v1/claims';
  const tokenAddress = 'GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ5LKG3FZTSZ3NYNEJBBENSN';

  beforeAll(async () => {
    process.env.API_KEY = 'test-key';

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

    app.use((req: any, res: any, next: any) => {
      req.headers['x-api-key'] = 'test-key';
      next();
    });

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();
    prisma = app.get(PrismaService);
    encryptionService = app.get(EncryptionService);
  });

  beforeEach(async () => {
    await prisma.claim.deleteMany();
    await prisma.campaign.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /claims creates a claim', async () => {
    // Create a campaign first
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });

    const res = await request(app.getHttpServer())
      .post(base)
      .send({
        campaignId: campaign.id,
        amount: 100.5,
        recipientRef: 'recipient-123',
        evidenceRef: 'evidence-456',
        tokenAddress,
      })
      .expect(201);

    const body = bodyAs<ClaimResponseDto>(res);

    expect(body.success).toBe(true);
    expect(body.data.status).toBe('requested');
    expect(body.data.amount).toBe(100.5);
    expect(body.data.recipientRef).toBe('recipient-123');
    expect(body.data.evidenceRef).toBe('evidence-456');
    expect(body.data.campaign.id).toBe(campaign.id);
  });

  it('POST /claims rejects invalid campaignId', async () => {
    await request(app.getHttpServer())
      .post(base)
      .send({
        campaignId: 'invalid-id',
        amount: 100.5,
        recipientRef: 'recipient-123',
        tokenAddress,
      })
      .expect(404);
  });

  it('GET /claims returns all claims', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });

    await prisma.claim.create({
      data: {
        campaignId: campaign.id,
        amount: 50,
        recipientRef: encryptionService.encrypt('recipient-1'),
      },
    });

    const res = await request(app.getHttpServer()).get(base).expect(200);

    const body = res.body as { success: boolean; data: { data: ClaimResponseDto[]; nextCursor?: string } };

    expect(body.success).toBe(true);
    expect(body.data.data).toHaveLength(1);
  });

  it('GET /claims/:id returns claim details', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });

    const claim = await prisma.claim.create({
      data: {
        campaignId: campaign.id,
        amount: 50,
        recipientRef: encryptionService.encrypt('recipient-1'),
      },
    });

    const res = await request(app.getHttpServer())
      .get(`${base}/${claim.id}`)
      .expect(200);

    const body = bodyAs<ClaimResponseDto>(res);

    expect(body.success).toBe(true);
    expect(body.data.id).toBe(claim.id);
    expect(body.data.status).toBe('requested');
  });

  it('POST /claims/:id/verify transitions requested to verified', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });

    const claim = await prisma.claim.create({
      data: {
        campaignId: campaign.id,
        amount: 50,
        recipientRef: encryptionService.encrypt('recipient-1'),
      },
    });

    const res = await request(app.getHttpServer())
      .post(`${base}/${claim.id}/verify`)
      .expect(200);

    const body = bodyAs<ClaimResponseDto>(res);

    expect(body.success).toBe(true);
    expect(body.data.status).toBe('verified');
  });

  it('POST /claims/:id/approve transitions verified to approved', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });

    const claim = await prisma.claim.create({
      data: {
        campaignId: campaign.id,
        amount: 50,
        recipientRef: encryptionService.encrypt('recipient-1'),
        status: 'verified',
      },
    });

    const res = await request(app.getHttpServer())
      .post(`${base}/${claim.id}/approve`)
      .expect(200);

    const body = bodyAs<ClaimResponseDto>(res);

    expect(body.success).toBe(true);
    expect(body.data.status).toBe('approved');
  });

  it('POST /claims/:id/disburse transitions approved to disbursed', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });

    const claim = await prisma.claim.create({
      data: {
        campaignId: campaign.id,
        amount: 50,
        recipientRef: encryptionService.encrypt('recipient-1'),
        status: 'approved',
      },
    });

    const res = await request(app.getHttpServer())
      .post(`${base}/${claim.id}/disburse`)
      .expect(200);

    const body = bodyAs<ClaimResponseDto>(res);

    expect(body.success).toBe(true);
    expect(body.data.status).toBe('disbursed');
  });

  it('PATCH /claims/:id/archive transitions disbursed to archived', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });

    const claim = await prisma.claim.create({
      data: {
        campaignId: campaign.id,
        amount: 50,
        recipientRef: encryptionService.encrypt('recipient-1'),
        status: 'disbursed',
      },
    });

    const res = await request(app.getHttpServer())
      .patch(`${base}/${claim.id}/archive`)
      .expect(200);

    const body = bodyAs<ClaimResponseDto>(res);

    expect(body.success).toBe(true);
    expect(body.data.status).toBe('archived');
  });

  it('POST /claims/:id/verify rejects invalid transition', async () => {
    const campaign = await prisma.campaign.create({
      data: { name: 'Test Campaign', budget: 1000 },
    });

    const claim = await prisma.claim.create({
      data: {
        campaignId: campaign.id,
        amount: 50,
        recipientRef: encryptionService.encrypt('recipient-1'),
        status: 'verified', // Already verified
      },
    });

    await request(app.getHttpServer())
      .post(`${base}/${claim.id}/verify`)
      .expect(400);
  });
  it('POST /claims rejects claim if over campaign budget', async () => {
    // Create a campaign with a small budget
    const campaign = await prisma.campaign.create({
      data: { name: 'Capped Campaign', budget: 100 },
    });

    // First claim within budget
    await request(app.getHttpServer())
      .post(base)
      .send({
        campaignId: campaign.id,
        amount: 60,
        recipientRef: 'recipient-1',
        tokenAddress,
      })
      .expect(201);

    // Second claim that would exceed the cap
    const res = await request(app.getHttpServer())
      .post(base)
      .send({
        campaignId: campaign.id,
        amount: 50, // 60 + 50 = 110 > 100
        recipientRef: 'recipient-2',
        tokenAddress,
      })
      .expect(400);

    expect(res.body.message).toMatch(/cap/i);
  });
});
