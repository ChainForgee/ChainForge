import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AuthOidcModule } from '../src/auth-oidc/auth-oidc.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../cache/redis.service';
import { AppRole } from '../src/auth/app-role.enum';
import { hashApiKey } from '../src/api-keys/api-key-hash.util';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('OIDC token flow (e2e)', () => {
  let app: INestApplication;
  const prisma = {
    apiKey: {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const revoked = new Map<string, number>();
  const redisClient = {
    zscore: jest.fn((_key: string, jti: string) => {
      const score = revoked.get(jti);
      return Promise.resolve(score === undefined ? null : String(score));
    }),
    zadd: jest.fn((_key: string, score: string, jti: string) => {
      revoked.set(jti, Number(score));
      return Promise.resolve(1);
    }),
    zremrangebyscore: jest.fn((_key: string, min: number, max: number) => {
      let deleted = 0;
      for (const [jti, score] of revoked.entries()) {
        if (score >= Number(min) && score <= Number(max)) {
          revoked.delete(jti);
          deleted += 1;
        }
      }
      return Promise.resolve(deleted);
    }),
  };

  beforeAll(async () => {
    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          JWT_PRIVATE_KEY: privateKey,
          JWT_PUBLIC_KEY: publicKey,
          API_KEY: 'env-api-key',
          JWT_ACCESS_TOKEN_TTL_SECONDS: '900',
          JWT_REFRESH_TOKEN_TTL_SECONDS: '604800',
        };
        return values[key];
      }),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AuthOidcModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(RedisService)
      .useValue({ getClient: () => redisClient })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    revoked.clear();
    jest.clearAllMocks();
  });

  it('issues, uses, refreshes, revokes, and introspects a JWT token', async () => {
    prisma.apiKey.findMany.mockResolvedValue([
      {
        id: 'api-key-1',
        keyHash: await hashApiKey('api-key-secret'),
        role: AppRole.operator,
        ngoId: 'ngo-1',
      },
    ]);

    const issueResponse = await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'client_credentials',
        client_secret: 'api-key-secret',
      })
      .expect(201);

    expect(issueResponse.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
      refresh_expires_in: 604800,
    });
    expect(typeof issueResponse.body.access_token).toBe('string');
    expect(typeof issueResponse.body.refresh_token).toBe('string');

    const userinfoResponse = await request(app.getHttpServer())
      .get('/oauth/userinfo')
      .set('Authorization', `Bearer ${issueResponse.body.access_token}`)
      .expect(200);

    expect(userinfoResponse.body).toMatchObject({
      role: AppRole.operator,
      ngoId: 'ngo-1',
      apiKeyId: 'api-key-1',
      authType: 'jwt',
    });

    const refreshResponse = await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'refresh_token',
        refresh_token: issueResponse.body.refresh_token,
      })
      .expect(201);

    expect(typeof refreshResponse.body.access_token).toBe('string');
    expect(refreshResponse.body.access_token).not.toEqual(
      issueResponse.body.access_token,
    );

    await request(app.getHttpServer())
      .post('/oauth/revoke')
      .send({ token: refreshResponse.body.access_token })
      .expect(201);

    const introspectResponse = await request(app.getHttpServer())
      .post('/oauth/introspect')
      .send({ token: refreshResponse.body.access_token })
      .expect(201);

    expect(introspectResponse.body).toEqual({ active: false });
  });

  it('rejects a client secret backed only by a legacy SHA-256 keyHash', async () => {
    prisma.apiKey.findMany.mockResolvedValue([
      {
        id: 'legacy-api-key',
        keyHash: createHash('sha256').update('api-key-secret').digest('hex'),
        role: AppRole.operator,
        ngoId: 'ngo-1',
      },
    ]);

    await request(app.getHttpServer())
      .post('/oauth/token')
      .send({
        grant_type: 'client_credentials',
        client_secret: 'api-key-secret',
      })
      .expect(401);

    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });
});
