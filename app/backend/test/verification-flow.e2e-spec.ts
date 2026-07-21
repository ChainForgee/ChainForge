import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { VersioningType } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from 'src/app.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { VerificationChannel } from '@prisma/client';
import { createHash } from 'crypto';
import { EncryptionService } from 'src/common/encryption/encryption.service';

describe('Verification flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let encryptionService: EncryptionService;
  const testApiKey = 'e2e-test-key-0001';
  const mockAuthDigest = createHash('sha256').update(testApiKey).digest('hex');

  const base = '/api/v1/verification';

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
    encryptionService = app.get(EncryptionService);

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
  });

  beforeEach(async () => {
    try {
      await prisma.verificationSession.deleteMany();
    } catch (err: unknown) {
      const message =
        err && typeof (err as { message?: string }).message === 'string'
          ? (err as { message: string }).message
          : '';
      if (
        message.includes('VerificationSession') &&
        message.includes('does not exist')
      ) {
        throw new Error(
          'VerificationSession table missing. Run: npx prisma migrate dev',
        );
      }
      throw err;
    }
  });

  afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { keyHash: mockAuthDigest } });
    await app.close();
  });

  describe('POST /verification/start', () => {
    it('should start verification and return sessionId (email)', async () => {
      const res = await request(app.getHttpServer())
        .post(`${base}/start`)
        .set('x-api-key', testApiKey)
        .send({ channel: 'email', email: 'user@example.com' })
        .expect(200);

      expect(res.body).toMatchObject({
        sessionId: expect.any(String),
        channel: 'email',
        expiresAt: expect.any(String),
        message: expect.any(String),
      });
      expect(res.body.sessionId.length).toBeGreaterThan(0);
    });

    it('should start verification for phone', async () => {
      const res = await request(app.getHttpServer())
        .post(`${base}/start`)
        .set('x-api-key', testApiKey)
        .send({ channel: 'phone', phone: '+15551234567' })
        .expect(200);

      expect(res.body.channel).toBe('phone');
      expect(res.body.sessionId).toBeDefined();
    });

    it('should reject missing email when channel is email', async () => {
      await request(app.getHttpServer())
        .post(`${base}/start`)
        .set('x-api-key', testApiKey)
        .send({ channel: 'email' })
        .expect(400);
    });

    it('should reject missing phone when channel is phone', async () => {
      await request(app.getHttpServer())
        .post(`${base}/start`)
        .set('x-api-key', testApiKey)
        .send({ channel: 'phone' })
        .expect(400);
    });

    it('should reject invalid channel', async () => {
      await request(app.getHttpServer())
        .post(`${base}/start`)
        .set('x-api-key', testApiKey)
        .send({ channel: 'sms', email: 'a@b.com' })
        .expect(400);
    });
  });

  describe('Successful flow: start -> complete', () => {
    it('should complete verification with correct code', async () => {
      const session = await prisma.verificationSession.create({
        data: {
          channel: VerificationChannel.email,
          identifier: encryptionService.encryptDeterministic('flow@example.com'),
          code: encryptionService.encrypt('123456'),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      const completeRes = await request(app.getHttpServer())
        .post(`${base}/complete`)
        .set('x-api-key', testApiKey)
        .send({ sessionId: session.id, code: '123456' })
        .expect(200);

      expect(completeRes.body).toMatchObject({
        sessionId: session.id,
        verified: true,
        message: 'Verification completed successfully.',
      });

      const updated = await prisma.verificationSession.findUnique({
        where: { id: session.id },
      });
      expect(updated?.status).toBe('completed');
    });
  });

  describe('POST /verification/complete', () => {
    it('should return 400 for wrong code', async () => {
      const session = await prisma.verificationSession.create({
        data: {
          channel: VerificationChannel.email,
          identifier: encryptionService.encryptDeterministic('wrong@example.com'),
          code: encryptionService.encrypt('123456'),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      await request(app.getHttpServer())
        .post(`${base}/complete`)
        .set('x-api-key', testApiKey)
        .send({ sessionId: session.id, code: '999999' })
        .expect(400);
    });

    it('should return 404 for unknown sessionId', async () => {
      await request(app.getHttpServer())
        .post(`${base}/complete`)
        .set('x-api-key', testApiKey)
        .send({
          sessionId: 'clv000000000000000000000',
          code: '123456',
        })
        .expect(404);
    });

    it('should reject invalid code format (non-digits)', async () => {
      const session = await prisma.verificationSession.create({
        data: {
          channel: VerificationChannel.email,
          identifier: encryptionService.encryptDeterministic('x@y.com'),
          code: encryptionService.encrypt('123456'),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      await request(app.getHttpServer())
        .post(`${base}/complete`)
        .set('x-api-key', testApiKey)
        .send({ sessionId: session.id, code: '12ab56' })
        .expect(400);
    });

    it('should reject code that is too short', async () => {
      const session = await prisma.verificationSession.create({
        data: {
          channel: VerificationChannel.email,
          identifier: encryptionService.encryptDeterministic('x@y.com'),
          code: encryptionService.encrypt('123456'),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      await request(app.getHttpServer())
        .post(`${base}/complete`)
        .set('x-api-key', testApiKey)
        .send({ sessionId: session.id, code: '123' })
        .expect(400);
    });
  });

  describe('POST /verification/resend', () => {
    it('should resend and allow complete with new code', async () => {
      const session = await prisma.verificationSession.create({
        data: {
          channel: VerificationChannel.email,
          identifier: encryptionService.encryptDeterministic('resend@example.com'),
          code: encryptionService.encrypt('111111'),
          resendCount: 0,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      const resendRes = await request(app.getHttpServer())
        .post(`${base}/resend`)
        .set('x-api-key', testApiKey)
        .send({ sessionId: session.id })
        .expect(200);

      expect(resendRes.body.sessionId).toBe(session.id);
      expect(resendRes.body.expiresAt).toBeDefined();

      const updated = await prisma.verificationSession.findUnique({
        where: { id: session.id },
      });
      expect(updated?.resendCount).toBe(1);
      expect(updated?.code).not.toBe(encryptionService.encrypt('111111'));

      const decryptedNewCode = encryptionService.decrypt(updated!.code);

      await request(app.getHttpServer())
        .post(`${base}/complete`)
        .set('x-api-key', testApiKey)
        .send({ sessionId: session.id, code: decryptedNewCode })
        .expect(200);
    });

    it('should return 404 for unknown sessionId', async () => {
      await request(app.getHttpServer())
        .post(`${base}/resend`)
        .set('x-api-key', testApiKey)
        .send({ sessionId: 'clv000000000000000000000' })
        .expect(404);
    });

    it('should return 400 when resend limit exceeded', async () => {
      const session = await prisma.verificationSession.create({
        data: {
          channel: VerificationChannel.email,
          identifier: encryptionService.encryptDeterministic('limit@example.com'),
          code: encryptionService.encrypt('123456'),
          resendCount: 3,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      await request(app.getHttpServer())
        .post(`${base}/resend`)
        .set('x-api-key', testApiKey)
        .send({ sessionId: session.id })
        .expect(400);
    });
  });
});
