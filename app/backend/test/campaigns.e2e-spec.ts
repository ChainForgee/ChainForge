import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import request, { Response as SupertestResponse } from 'supertest';
import { AppModule } from 'src/app.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { App } from 'supertest/types';
jest.setTimeout(30000);
type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
};

type CampaignResponseDto = {
  id: string;
  name: string;
  budget: number;
  archivedAt: string | null;
};

function bodyAs<T>(res: SupertestResponse): ApiResponse<T> {
  return res.body as ApiResponse<T>;
}

describe('Campaigns (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const base = '/api/v1/campaigns';
  const testApiKey = 'e2e-test-key-0001';
  const testApiKeyHash = '7cd155083be719224524695fc6e61cf3747b99dd3f6260e392f1b3b69577dcd9';
  const authHeader = { 'X-Api-Key': testApiKey } as Record<string, string>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();

    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
      prefix: 'v',
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
    await prisma.claim.deleteMany();
    await prisma.balanceLedger.deleteMany();
    await prisma.aidPackage.deleteMany();
    await prisma.campaign.deleteMany();
  });

  afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { keyHash: testApiKeyHash } });
    await app.close();
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  it('POST /campaigns creates a campaign', async () => {
    const res = await request(app.getHttpServer())
      .post(base)
      .set(authHeader)
      .send({ name: 'Test Campaign', budget: 1000 })
      .expect(201);

    const body = bodyAs<CampaignResponseDto>(res);

    expect(body.success).toBe(true);
    expect(body.data.name).toBe('Test Campaign');
    expect(body.data.budget).toBeDefined();
  });

  it('POST /campaigns rejects missing required fields', async () => {
    await request(app.getHttpServer())
      .post(base)
      .set(authHeader)
      .send({ budget: 1000 })
      .expect(400);

    await request(app.getHttpServer())
      .post(base)
      .set(authHeader)
      .send({ name: 'Missing Budget' })
      .expect(400);
  });

  it('POST /campaigns rejects invalid budgets', async () => {
    await request(app.getHttpServer())
      .post(base)
      .set(authHeader)
      .send({ name: 'Bad Budget', budget: -1 })
      .expect(400);
  });

  it('PATCH /campaigns/:id/archive is idempotent', async () => {
    const createdRes = await request(app.getHttpServer())
      .post(base)
      .set(authHeader)
      .send({ name: 'Archive Me', budget: 10 })
      .expect(201);

    const createdBody = bodyAs<CampaignResponseDto>(createdRes);
    const id = createdBody.data.id;

    const firstRes = await request(app.getHttpServer())
      .patch(`${base}/${id}/archive`)
      .set(authHeader)
      .expect(200);

    const firstBody = bodyAs<CampaignResponseDto>(firstRes);

    expect(firstBody.success).toBe(true);
    expect(firstBody.data.archivedAt).toBeTruthy();

    const secondRes = await request(app.getHttpServer())
      .patch(`${base}/${id}/archive`)
      .set(authHeader)
      .expect(200);

    const secondBody = bodyAs<CampaignResponseDto>(secondRes);

    expect(secondBody.success).toBe(true);
    expect(secondBody.data.archivedAt).toBeTruthy();
    expect(secondBody.message ?? '').toMatch(/already archived/i);
  });

  it('GET /campaigns returns a list', async () => {
    await request(app.getHttpServer())
      .post(base)
      .set(authHeader)
      .send({ name: 'List Me', budget: 5 })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(base)
      .set(authHeader)
      .expect(200);

    const body = bodyAs<CampaignResponseDto[]>(res);

    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(1);
  });

  it('GET /campaigns/:id returns 404 for missing campaign', async () => {
    await request(app.getHttpServer())
      .get(`${base}/does-not-exist`)
      .set(authHeader)
      .expect(404);
  });

  describe('Campaigns HTTP cache', () => {
    it('GET /campaigns returns Cache-Control with max-age=30', async () => {
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