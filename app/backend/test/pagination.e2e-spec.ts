import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import request, { Response as SupertestResponse } from 'supertest';
import { AppModule } from 'src/app.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { BudgetService } from 'src/common/budget/budget.service';
import { EncryptionService } from 'src/common/encryption/encryption.service';
import { App } from 'supertest/types';

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

describe('Pagination (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let encryptionService: EncryptionService;

  const base = '/api/v1/claims';

  beforeAll(async () => {
    process.env.API_KEY = 'dev-admin-key-000';

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
      if (!req.headers['x-api-key']) {
        req.headers['x-api-key'] = 'dev-admin-key-000';
      }
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
    await prisma.balanceLedger.deleteMany();
    await prisma.claim.deleteMany();
    await prisma.campaign.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  it('verifies default page size, max caps, and cursor advancement', async () => {
    // 1. Create a campaign first
    const campaign = await prisma.campaign.create({
      data: { name: 'Pagination Campaign', budget: 100000 },
    });

    // 2. Create 250 claims
    const claimData = Array.from({ length: 250 }, (_, i) => ({
      campaignId: campaign.id,
      amount: 10,
      recipientRef: encryptionService.encrypt(`recipient-${i}`),
    }));

    await prisma.claim.createMany({
      data: claimData,
    });

    // 3. Query without parameters (should use default 25 limit)
    const defaultRes = await request(app.getHttpServer())
      .get(base)
      .expect(200);

    const defaultBody = bodyAs<{ data: ClaimResponseDto[]; nextCursor: string | null }>(defaultRes);
    expect(defaultBody.success).toBe(true);
    expect(defaultBody.data.data).toHaveLength(25);
    expect(defaultBody.data.nextCursor).toBeDefined();
    expect(defaultBody.data.nextCursor).not.toBeNull();

    // 4. Query with limit = 200 (should cap at 100 max)
    const cappedRes = await request(app.getHttpServer())
      .get(`${base}?limit=200`)
      .expect(200);

    const cappedBody = bodyAs<{ data: ClaimResponseDto[]; nextCursor: string | null }>(cappedRes);
    expect(cappedBody.success).toBe(true);
    expect(cappedBody.data.data).toHaveLength(100);
    expect(cappedBody.data.nextCursor).toBeDefined();
    expect(cappedBody.data.nextCursor).not.toBeNull();

    // 5. Query with limit = 10 (Page 1)
    const page1Res = await request(app.getHttpServer())
      .get(`${base}?limit=10`)
      .expect(200);

    const page1Body = bodyAs<{ data: ClaimResponseDto[]; nextCursor: string | null }>(page1Res);
    expect(page1Body.success).toBe(true);
    expect(page1Body.data.data).toHaveLength(10);
    const cursor = page1Body.data.nextCursor;
    expect(cursor).toBeDefined();
    expect(cursor).not.toBeNull();

    // 6. Query Page 2 using the nextCursor
    const page2Res = await request(app.getHttpServer())
      .get(`${base}?limit=10&cursor=${cursor}`)
      .expect(200);

    const page2Body = bodyAs<{ data: ClaimResponseDto[]; nextCursor: string | null }>(page2Res);
    expect(page2Body.success).toBe(true);
    expect(page2Body.data.data).toHaveLength(10);
    
    // The items returned on page 2 should be different from page 1
    const page1Ids = page1Body.data.data.map(item => item.id);
    const page2Ids = page2Body.data.data.map(item => item.id);
    
    // No intersection between page 1 and page 2
    for (const id of page2Ids) {
      expect(page1Ids).not.toContain(id);
    }
  });
});
