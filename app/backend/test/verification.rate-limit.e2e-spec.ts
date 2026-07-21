import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { PrismaService } from '../src/prisma/prisma.service';
import { createRateLimiter } from '../src/common/security/security.module';
import { createHash } from 'crypto';

describe('Verification rate limiting (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const testApiKey = 'e2e-rate-limit-key';
  // codeql[js/insufficient-password-hash]
  const mockAuthDigest = createHash('sha256').update(testApiKey).digest('hex');

  beforeEach(async () => {
    // Use small limits for tests
    process.env.API_RATE_LIMIT = '2';
    process.env.THROTTLE_TTL = '1000';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Configure prefix and versioning
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
      prefix: 'v',
    });

    // Register rate limit middleware (mirroring main.ts setup)
    app.use(createRateLimiter(app.get(ConfigService), app.get(RedisService)));

    await app.init();
    prisma = app.get(PrismaService);

    // Seed the API key so e2e calls are authenticated
    await prisma.apiKey.upsert({
      where: { keyHash: mockAuthDigest },
      update: { revokedAt: null },
      create: {
        key: testApiKey,
        keyHash: mockAuthDigest,
        keyPreview: testApiKey.slice(0, 8),
        role: 'admin',
      },
    });

    // Clear rate limits in Redis before each test
    const redis = app.get(RedisService).getOrThrow();
    const keys = await redis.keys('ratelimit:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  afterEach(async () => {
    if (prisma) {
      await prisma.apiKey.deleteMany({ where: { keyHash: mockAuthDigest } });
    }
    if (app) {
      await app.close();
    }
  });

  it('should enforce rate limit on verification POST', async () => {
    const agent = request(app.getHttpServer());

    // First two requests should succeed (within limit of 2)
    await agent
      .post('/api/v1/verification')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({})
      .expect(res => {
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(300);
        expect(
          res.header['ratelimit-limit'] || res.header['RateLimit-Limit'],
        ).toBeDefined();
      });

    await agent
      .post('/api/v1/verification')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({})
      .expect(res => {
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(300);
      });

    // Third request should be rate limited (429)
    await agent
      .post('/api/v1/verification')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({})
      .expect(429)
      .expect(res => {
        expect(
          res.header['ratelimit-limit'] || res.header['RateLimit-Limit'],
        ).toBeDefined();
        expect(
          res.header['ratelimit-remaining'] ||
            res.header['RateLimit-Remaining'],
        ).toBeDefined();
        expect(
          res.header['ratelimit-reset'] || res.header['RateLimit-Reset'],
        ).toBeDefined();
      });
  });

  it('should not rate limit authenticated requests to non-verification endpoints', async () => {
    const agent = request(app.getHttpServer());

    // Send multiple requests with Authorization header to a non-verification endpoint (like /api/v1/claims)
    // and ensure they are not throttled (i.e. we don't get 429)
    await agent
      .get('/api/v1/claims')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(res => {
        expect(res.status).not.toBe(429);
      });

    await agent
      .get('/api/v1/claims')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(res => {
        expect(res.status).not.toBe(429);
      });

    await agent
      .get('/api/v1/claims')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(res => {
        expect(res.status).not.toBe(429);
      });
  });
});
