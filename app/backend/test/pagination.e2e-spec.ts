import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from 'src/app.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { BudgetService } from 'src/common/budget/budget.service';
import { App } from 'supertest/types';

jest.setTimeout(180000);

describe('Pagination (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const base = '/api/v1/claims';

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
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();
    prisma = app.get(PrismaService);
  }, 180000);

  beforeEach(async () => {
    await prisma.claim.deleteMany();
    await prisma.campaign.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  it('asserts pagination defaults, max caps, and cursor traversal', async () => {
    // 1. Create a campaign first (claims require a campaign)
    const campaign = await prisma.campaign.create({
      data: { name: 'Pagination Test Campaign', budget: 1000000 },
    });

    // 2. Insert 250 claims
    const claimData = Array.from({ length: 250 }).map((_, index) => ({
      campaignId: campaign.id,
      amount: 1.0,
      recipientRef: `recipient-${index}`,
    }));

    await prisma.claim.createMany({
      data: claimData,
    });

    // 3. Assert default page = 25
    const resDefault = await request(app.getHttpServer())
      .get(base)
      .expect(200);

    expect(resDefault.body.success).toBe(true);
    expect(resDefault.body.data.data).toHaveLength(25);
    expect(resDefault.body.data.nextCursor).toBeDefined();

    const firstPageCursor = resDefault.body.data.nextCursor;

    // 4. Assert limit=200 caps at 100
    const resCap = await request(app.getHttpServer())
      .get(`${base}?limit=200`)
      .expect(200);

    expect(resCap.body.success).toBe(true);
    expect(resCap.body.data.data).toHaveLength(100);
    expect(resCap.body.data.nextCursor).toBeDefined();

    // 5. Assert ?cursor= advances correctly
    const resPage2 = await request(app.getHttpServer())
      .get(`${base}?cursor=${firstPageCursor}`)
      .expect(200);

    expect(resPage2.body.success).toBe(true);
    expect(resPage2.body.data.data).toHaveLength(25);
    expect(resPage2.body.data.nextCursor).toBeDefined();

    // The first item of the second page should not be the same as the last item of the first page (or any item on the first page)
    const firstPageIds = resDefault.body.data.data.map((item: any) => item.id);
    const secondPageFirstId = resPage2.body.data.data[0].id;
    expect(firstPageIds).not.toContain(secondPageFirstId);
  });
});
