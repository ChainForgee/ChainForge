import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt, importPKCS8, SignJWT } from 'jose';
import { AppRole } from '../src/auth/app-role.enum';
import { hashApiKey } from '../src/api-keys/api-key-hash.util';
import { TokenController } from '../src/auth-oidc/token.controller';
import { TokenService } from '../src/auth-oidc/token.service';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function makeTokenService(overrides: Record<string, string | undefined> = {}) {
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
      for (const [jti, score] of revoked.entries()) {
        if (score >= Number(min) && score <= Number(max)) {
          revoked.delete(jti);
        }
      }
      return Promise.resolve(0);
    }),
  };
  const prisma = {
    apiKey: {
      findMany: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const configValues: Record<string, string | undefined> = {
    JWT_PRIVATE_KEY: privateKey,
    JWT_PUBLIC_KEY: publicKey,
    JWT_ISSUER: 'test-issuer',
    JWT_AUDIENCE: 'test-audience',
    JWT_ACCESS_TOKEN_TTL_SECONDS: '60',
    JWT_REFRESH_TOKEN_TTL_SECONDS: '120',
    API_KEY: 'env-api-key',
    ...overrides,
  };
  const config = {
    get: jest.fn((key: string) => configValues[key]),
  };

  return {
    config,
    prisma,
    redisClient,
    revoked,
    service: new TokenService(
      config as unknown as ConfigService,
      prisma as any,
      { getClient: () => redisClient } as any,
    ),
  };
}

describe('TokenService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects missing and invalid client credentials', async () => {
    const { service, prisma } = makeTokenService();
    prisma.apiKey.findMany.mockResolvedValue([]);

    await expect(service.issueForClientCredentials(undefined)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(service.issueForClientCredentials('bad-key')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('issues tokens for stored API keys and exposes active introspection data', async () => {
    const { service, prisma } = makeTokenService();
    prisma.apiKey.findMany.mockResolvedValue([
      {
        id: 'api-key-1',
        keyHash: await hashApiKey('api-key-secret'),
        role: AppRole.operator,
        ngoId: 'ngo-1',
      },
    ]);

    const pair = await service.issueForClientCredentials('api-key-secret');
    const verified = await service.verifyAccessToken(pair.access_token);
    const introspection = await service.introspect(pair.access_token);

    expect(pair).toMatchObject({
      token_type: 'Bearer',
      expires_in: 60,
      refresh_expires_in: 120,
    });
    expect(verified.principal).toEqual({
      role: AppRole.operator,
      ngoId: 'ngo-1',
      apiKeyId: 'api-key-1',
    });
    expect(introspection).toMatchObject({
      active: true,
      role: AppRole.operator,
      token_use: 'access',
      ngoId: 'ngo-1',
      apiKeyId: 'api-key-1',
    });
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'api-key-1' },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it('falls back to the environment API key and default TTLs', async () => {
    const { service, prisma } = makeTokenService({
      JWT_ACCESS_TOKEN_TTL_SECONDS: '0',
      JWT_REFRESH_TOKEN_TTL_SECONDS: 'not-a-number',
    });
    prisma.apiKey.findMany.mockResolvedValue([]);

    const pair = await service.issueForClientCredentials('env-api-key');
    const verified = await service.verifyAccessToken(pair.access_token);

    expect(pair.expires_in).toBe(900);
    expect(pair.refresh_expires_in).toBe(604800);
    expect(verified.principal).toEqual({ role: AppRole.admin });
  });

  it('refreshes tokens and revokes the old refresh token', async () => {
    const { service, prisma, redisClient } = makeTokenService();
    prisma.apiKey.findMany.mockResolvedValue([
      {
        id: 'api-key-1',
        keyHash: await hashApiKey('api-key-secret'),
        role: AppRole.operator,
        ngoId: null,
      },
    ]);
    const pair = await service.issueForClientCredentials('api-key-secret');

    const refreshed = await service.refresh(pair.refresh_token);
    const oldRefresh = decodeJwt(pair.refresh_token);

    expect(refreshed.access_token).not.toBe(pair.access_token);
    expect(redisClient.zadd).toHaveBeenCalledWith(
      'oidc:revoked:jti',
      String(oldRefresh.exp),
      oldRefresh.jti,
    );
    await expect(service.verifyAccessToken(pair.refresh_token)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects missing refresh tokens and reports inactive invalid tokens', async () => {
    const { service } = makeTokenService();

    await expect(service.refresh(undefined)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.verifyAccessToken('not-a-jwt')).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(service.introspect('not-a-jwt')).resolves.toEqual({
      active: false,
    });
    await expect(service.revoke('not-a-jwt')).resolves.toBe(false);
  });

  it('rejects tokens with invalid claims, roles, use, and revocation state', async () => {
    const { service, revoked } = makeTokenService();
    const now = Math.floor(Date.now() / 1000);
    const signingKey = await importPKCS8(privateKey, 'RS256');
    const makeJwt = (claims: Record<string, unknown> & { jti?: string }) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
        .setIssuer('test-issuer')
        .setAudience('test-audience')
        .setSubject('subject')
        .setJti(String(claims.jti ?? 'jti-1'))
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .sign(signingKey);

    await expect(
      service.verifyAccessToken(
        await makeJwt({ jti: 'missing-role', token_use: 'access' }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      service.verifyAccessToken(
        await makeJwt({
          jti: 'bad-role',
          role: 'superuser',
          token_use: 'access',
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      service.verifyAccessToken(
        await makeJwt({
          jti: 'wrong-use',
          role: AppRole.operator,
          token_use: 'refresh',
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);

    revoked.set('revoked-jti', now + 60);
    await expect(
      service.verifyAccessToken(
        await makeJwt({
          jti: 'revoked-jti',
          role: AppRole.operator,
          token_use: 'access',
        }),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('requires configured PEM keys', async () => {
    const { service, prisma } = makeTokenService({
      JWT_PRIVATE_KEY: undefined,
    });
    prisma.apiKey.findMany.mockResolvedValue([]);

    await expect(
      service.issueForClientCredentials('env-api-key'),
    ).rejects.toThrow('JWT_PRIVATE_KEY is required for OIDC JWT support');
  });
});

describe('TokenController', () => {
  it('routes token grants to the matching service method', async () => {
    const tokenService = {
      issueForClientCredentials: jest.fn().mockResolvedValue({ issued: true }),
      refresh: jest.fn().mockResolvedValue({ refreshed: true }),
      introspect: jest.fn(),
      revoke: jest.fn(),
    };
    const controller = new TokenController(tokenService as any);

    await expect(
      controller.token({
        grant_type: 'client_credentials',
        client_secret: 'api-key-secret',
      }),
    ).resolves.toEqual({ issued: true });
    await expect(
      controller.token({
        grant_type: 'refresh_token',
        refresh_token: 'refresh-token',
      }),
    ).resolves.toEqual({ refreshed: true });
    expect(tokenService.issueForClientCredentials).toHaveBeenCalledWith(
      'api-key-secret',
    );
    expect(tokenService.refresh).toHaveBeenCalledWith('refresh-token');
  });

  it('returns request userinfo and token introspection responses', async () => {
    const tokenService = {
      issueForClientCredentials: jest.fn(),
      refresh: jest.fn(),
      introspect: jest.fn().mockResolvedValue({ active: true }),
      revoke: jest.fn().mockResolvedValue(true),
    };
    const controller = new TokenController(tokenService as any);
    const user = { role: AppRole.operator, authType: 'jwt' };

    expect(controller.userinfo({ user } as any)).toBe(user);
    await expect(
      controller.introspect({ token: 'access-token' }),
    ).resolves.toEqual({ active: true });
    await expect(controller.revoke({ token: 'access-token' })).resolves.toEqual(
      {
        revoked: true,
      },
    );
  });
});
