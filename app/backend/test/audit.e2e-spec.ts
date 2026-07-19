import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { AppModule } from 'src/app.module';
import { PrismaService } from 'src/prisma/prisma.service';
import request from 'supertest';
import { App } from 'supertest/types';

describe('Audit (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const base = '/api/v1/audit';
  const testApiKey = 'e2e-test-key-0003';
  const testApiKeyHash = 'b4b40ca8559ecd4e296d5b0007eeab955dd480259c25a19d88bb4ef0cfb2c0bb';
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
    await prisma.auditLog.deleteMany();
  });

  afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { keyHash: testApiKeyHash } });
    await app.close();
  });

  describe('Audit HTTP cache', () => {
    it('GET /audit returns Cache-Control with max-age=30', async () => {
      await prisma.auditLog.create({
        data: {
          actorId: 'test-actor',
          entity: 'campaign',
          entityId: 'test-entity',
          action: 'test',
        },
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
      await prisma.auditLog.create({
        data: {
          actorId: 'test-actor',
          entity: 'campaign',
          entityId: 'test-entity-2',
          action: 'test',
        },
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