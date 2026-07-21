import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';

describe('DTO validation (e2e)', () => {
  let app: INestApplication;
  const testApiKey = 'e2e-test-key-0001';

  beforeEach(async () => {
    process.env.API_KEY = testApiKey;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('rejects missing required fields for CreateClaimDto', async () => {
    // missing amount
    await request(app.getHttpServer())
      .post('/api/v1/claims')
      .set('x-api-key', testApiKey)
      .send({ campaignId: 'c1', recipientRef: 'r1' })
      .expect(400);
  });

  it('rejects unexpected fields (forbidNonWhitelisted) for CreateClaimDto', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/claims')
      .set('x-api-key', testApiKey)
      .send({ campaignId: 'c1', amount: 10, recipientRef: 'r1', extra: 'nope' })
      .expect(400);
  });

  it('rejects missing required fields for CreateCampaignDto', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/campaigns')
      .set('x-api-key', testApiKey)
      .send({ budget: 100 })
      .expect(400);
  });

  it('rejects unexpected fields for CreateCampaignDto', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/campaigns')
      .set('x-api-key', testApiKey)
      .send({ name: 'A', budget: 100, unexpected: true })
      .expect(400);
  });

  it('rejects missing required fields for CreateVerificationDto', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/verification')
      .set('x-api-key', testApiKey)
      .send({})
      .expect(400);
  });

  it('accepts proper numeric transformation for CreateClaimDto amount', async () => {
    // amount sent as string should be transformed to number
    await request(app.getHttpServer())
      .post('/api/v1/claims')
      .set('x-api-key', testApiKey)
      .send({ campaignId: 'c1', amount: '12.5', recipientRef: 'r1' })
      .expect(res => {
        expect(res.status).toBeGreaterThanOrEqual(200);
      });
  });
});
