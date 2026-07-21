import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createHash } from 'crypto';

function setupApp(app: INestApplication) {
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
    prefix: 'v',
  });
}

/**
 * Sandbox Guard E2E Tests
 *
 * Verifies that sandbox endpoints are:
 * 1. REJECTED (403 Forbidden) when SANDBOX_ENABLED is not set or not 'true'
 * 2. ACCEPTED when SANDBOX_ENABLED='true' (tested with appropriate auth)
 *
 * These tests ensure the sandbox feature is disabled by default and requires
 * explicit enablement, preventing accidental seed operations in production.
 */
describe('Sandbox Guard (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const originalSandboxEnabled = process.env.SANDBOX_ENABLED;
  const adminKey = 'dev-admin-key-000';
  const adminKeyHash = createHash('sha256').update(adminKey).digest('hex');

  beforeAll(async () => {
    // Ensure SANDBOX_ENABLED is NOT set before creating the module
    delete process.env.SANDBOX_ENABLED;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    // Seed the API key so e2e calls are authenticated
    await prisma.apiKey.upsert({
      where: { keyHash: adminKeyHash },
      update: { revokedAt: null },
      create: {
        key: adminKey,
        keyHash: adminKeyHash,
        keyPreview: adminKey.slice(0, 8),
        role: 'admin',
      },
    });
  });

  afterAll(async () => {
    // Restore original environment variable
    if (originalSandboxEnabled !== undefined) {
      process.env.SANDBOX_ENABLED = originalSandboxEnabled;
    } else {
      delete process.env.SANDBOX_ENABLED;
    }
    await prisma.apiKey.deleteMany({ where: { keyHash: adminKeyHash } });
    await app.close();
  });

  describe('Non-sandbox environments (SANDBOX_ENABLED not set)', () => {
    it('should reject POST /api/v1/admin/sandbox/seed with 403', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/admin/sandbox/seed')
        .set('x-api-key', adminKey);

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('SANDBOX_ENABLED=true');
    });

    it('should reject POST /api/v1/admin/sandbox/seed/tenant with 403', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/admin/sandbox/seed/tenant')
        .set('x-api-key', adminKey);

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('SANDBOX_ENABLED=true');
    });

    it('should reject POST /api/v1/admin/sandbox/seed/campaigns with 403', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/admin/sandbox/seed/campaigns')
        .set('x-api-key', adminKey);

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('SANDBOX_ENABLED=true');
    });

    it('should reject POST /api/v1/admin/sandbox/seed/claims with 403', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/admin/sandbox/seed/claims')
        .set('x-api-key', adminKey);

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('SANDBOX_ENABLED=true');
    });

    it('should reject DELETE /api/v1/admin/sandbox/seed with 403', async () => {
      const response = await request(app.getHttpServer())
        .delete('/api/v1/admin/sandbox/seed')
        .set('x-api-key', adminKey);

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('SANDBOX_ENABLED=true');
    });

    it('should reject sandbox endpoints even with valid admin API key', async () => {
      // This test ensures that having proper authentication is not enough;
      // the SANDBOX_ENABLED flag must also be explicitly set
      const response = await request(app.getHttpServer())
        .post('/api/v1/admin/sandbox/seed')
        .set('x-api-key', adminKey)
        .send({});

      expect(response.status).toBe(403);
    });
  });

  describe('Non-sandbox environments (SANDBOX_ENABLED set to false)', () => {
    let testApp: INestApplication;

    beforeAll(async () => {
      process.env.SANDBOX_ENABLED = 'false';

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      testApp = moduleFixture.createNestApplication();
      setupApp(testApp);
      await testApp.init();
    });

    afterAll(async () => {
      await testApp.close();
    });

    it('should reject POST /api/v1/admin/sandbox/seed with 403 when SANDBOX_ENABLED=false', async () => {
      const response = await request(testApp.getHttpServer())
        .post('/api/v1/admin/sandbox/seed')
        .set('x-api-key', adminKey);

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('SANDBOX_ENABLED=true');
    });
  });

  describe('Non-sandbox environments (SANDBOX_ENABLED set to invalid value)', () => {
    let testApp: INestApplication;

    beforeAll(async () => {
      process.env.SANDBOX_ENABLED = 'yes'; // Invalid value (must be exactly 'true')

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      testApp = moduleFixture.createNestApplication();
      setupApp(testApp);
      await testApp.init();
    });

    afterAll(async () => {
      await testApp.close();
    });

    it('should reject POST /api/v1/admin/sandbox/seed with 403 when SANDBOX_ENABLED=yes', async () => {
      const response = await request(testApp.getHttpServer())
        .post('/api/v1/admin/sandbox/seed')
        .set('x-api-key', adminKey);

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toContain('SANDBOX_ENABLED=true');
    });
  });

  describe('Sandbox environment (SANDBOX_ENABLED=true)', () => {
    let testApp: INestApplication;

    beforeAll(async () => {
      process.env.SANDBOX_ENABLED = 'true';

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      testApp = moduleFixture.createNestApplication();
      setupApp(testApp);
      await testApp.init();
    });

    afterAll(async () => {
      await testApp.close();
    });

    it('should allow POST /api/v1/admin/sandbox/seed/tenant when enabled', async () => {
      const response = await request(testApp.getHttpServer())
        .post('/api/v1/admin/sandbox/seed/tenant')
        .set('x-api-key', adminKey);

      // Should not be 403 (may be 200/201 or other success code)
      expect(response.status).not.toBe(403);
    });

    it('should allow POST /api/v1/admin/sandbox/seed/campaigns when enabled', async () => {
      // Seed tenant first to ensure campaigns have a valid ngoId
      await request(testApp.getHttpServer())
        .post('/api/v1/admin/sandbox/seed/tenant')
        .set('x-api-key', adminKey);

      const response = await request(testApp.getHttpServer())
        .post('/api/v1/admin/sandbox/seed/campaigns')
        .set('x-api-key', adminKey);

      // Should not be 403
      expect(response.status).not.toBe(403);
    });

    it('should allow DELETE /api/v1/admin/sandbox/seed when enabled', async () => {
      const response = await request(testApp.getHttpServer())
        .delete('/api/v1/admin/sandbox/seed')
        .set('x-api-key', adminKey);

      // Should not be 403
      expect(response.status).not.toBe(403);
    });
  });
});
