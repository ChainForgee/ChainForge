import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import express from 'express';
import { AppModule } from '../src/app.module';
import {
  buildCorsOptions,
  createCorsOriginValidator,
  createHelmetMiddleware,
  createRateLimiter,
} from '../src/common/security/security.module';

const createTestApp = async () => {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();

  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
    prefix: 'v',
  });

  const configService = app.get(ConfigService);
  app.use(createHelmetMiddleware(configService));
  app.use(createCorsOriginValidator(configService));
  app.enableCors(buildCorsOptions(configService));
  app.use(createRateLimiter(configService));

  // Body parser for CSP reports with 8KiB limit
  app.use(
    '/api/v1/csp-report',
    express.json({
      type: ['application/csp-report', 'application/json'],
      limit: '8kb',
    }),
  );

  await app.init();
  return app;
};

const validCspReport = {
  'csp-report': {
    'document-uri': 'https://example.com/page',
    'violated-directive': 'script-src',
    'effective-directive': 'script-src',
    'original-policy': "default-src 'self'; script-src 'self'",
    disposition: 'enforce',
    'blocked-uri': 'https://evil.com/script.js',
    'source-file': 'https://example.com/app.js',
    'line-number': 42,
    'status-code': 200,
  },
};

describe('CSP Report Endpoint (e2e)', () => {
  let app: INestApplication;

  const originalEnv = {
    API_RATE_LIMIT: process.env.API_RATE_LIMIT,
    THROTTLE_TTL: process.env.THROTTLE_TTL,
    CORS_ORIGINS: process.env.CORS_ORIGINS,
  };

  beforeAll(async () => {
    process.env.API_RATE_LIMIT = '1000';
    process.env.THROTTLE_TTL = '60000';
    process.env.CORS_ORIGINS = 'http://localhost:3000';

    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();

    process.env.API_RATE_LIMIT = originalEnv.API_RATE_LIMIT;
    process.env.THROTTLE_TTL = originalEnv.THROTTLE_TTL;
    process.env.CORS_ORIGINS = originalEnv.CORS_ORIGINS;
  });

  describe('POST /api/v1/csp-report', () => {
    it('should accept a valid CSP report and return 204', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(validCspReport);

      expect(response.status).toBe(204);
      expect(response.body).toEqual({});
    });

    it('should accept CSP report with application/json content type', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/csp-report')
        .set('Content-Type', 'application/json')
        .send(validCspReport);

      expect(response.status).toBe(204);
    });

    it('should handle duplicate reports (idempotency)', async () => {
      const uniqueReport = {
        'csp-report': {
          ...validCspReport['csp-report'],
          'source-file': `https://example.com/unique-${Date.now()}.js`,
        },
      };

      // First submission
      const first = await request(app.getHttpServer())
        .post('/api/v1/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(uniqueReport);

      expect(first.status).toBe(204);

      // Second submission (duplicate)
      const second = await request(app.getHttpServer())
        .post('/api/v1/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(uniqueReport);

      expect(second.status).toBe(204);
    });

    it('should accept minimal CSP report', async () => {
      const minimalReport = {
        'csp-report': {
          'violated-directive': 'default-src',
        },
      };

      const response = await request(app.getHttpServer())
        .post('/api/v1/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(minimalReport);

      expect(response.status).toBe(204);
    });

    it('should reject report without csp-report wrapper', async () => {
      const invalidReport = {
        'violated-directive': 'script-src',
        'blocked-uri': 'https://evil.com/script.js',
      };

      const response = await request(app.getHttpServer())
        .post('/api/v1/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(invalidReport);

      expect(response.status).toBe(400);
    });

    it('should reject reports exceeding 8KiB', async () => {
      const largeReport = {
        'csp-report': {
          ...validCspReport['csp-report'],
          'script-sample': 'x'.repeat(10 * 1024), // 10KiB of data
        },
      };

      const response = await request(app.getHttpServer())
        .post('/api/v1/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(largeReport);

      expect(response.status).toBe(413);
    });

    it('should be accessible without authentication (public endpoint)', async () => {
      // No Authorization header, no API key
      const response = await request(app.getHttpServer())
        .post('/api/v1/csp-report')
        .set('Content-Type', 'application/csp-report')
        .send(validCspReport);

      // Should not return 401 or 403
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
      expect(response.status).toBe(204);
    });
  });
});
