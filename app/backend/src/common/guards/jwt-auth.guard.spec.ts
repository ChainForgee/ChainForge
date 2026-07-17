import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt } from 'jose';
import { AppRole } from '../../auth/app-role.enum';
import { TokenService } from '../../auth-oidc/token.service';
import { JwtAuthGuard } from './jwt-auth.guard';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function makeContext(authorization?: string) {
  const req: { headers: Record<string, string>; user?: unknown } = {
    headers: authorization ? { authorization } : {},
  };

  return {
    req,
    context: {
      switchToHttp: () => ({
        getRequest: () => req,
      }),
    },
  };
}

describe('JwtAuthGuard', () => {
  const redisClient = {
    zscore: jest.fn(),
    zadd: jest.fn(),
    zremrangebyscore: jest.fn(),
  };
  const redisService = {
    getClient: () => redisClient,
  };
  const prisma = {
    apiKey: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };

  let tokenService: TokenService;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    redisClient.zscore.mockResolvedValue(null);
    redisClient.zadd.mockResolvedValue(1);
    redisClient.zremrangebyscore.mockResolvedValue(0);
    prisma.apiKey.findFirst.mockResolvedValue({
      id: 'api-key-1',
      role: AppRole.operator,
      ngoId: 'ngo-1',
    });
    prisma.apiKey.update.mockResolvedValue({});

    const config = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          JWT_PRIVATE_KEY: privateKey,
          JWT_PUBLIC_KEY: publicKey,
          API_KEY: 'env-api-key',
        };
        return values[key];
      }),
    };

    tokenService = new TokenService(
      config as unknown as ConfigService,
      prisma as any,
      redisService as any,
    );
    guard = new JwtAuthGuard(tokenService);
  });

  it('rejects a JWT whose jti is present in the Redis revocation set', async () => {
    const pair = await tokenService.issueForClientCredentials('api-key-secret');
    const decoded = decodeJwt(pair.access_token);
    redisClient.zscore.mockImplementation((_key: string, jti: string) =>
      Promise.resolve(jti === decoded.jti ? String(decoded.exp) : null),
    );

    const { context } = makeContext(`Bearer ${pair.access_token}`);

    await expect(guard.canActivate(context as any)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
