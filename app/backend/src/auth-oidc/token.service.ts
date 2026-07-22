import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppRole } from '../auth/app-role.enum';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../../cache/redis.service';
import { createHash, randomUUID } from 'node:crypto';
import {
  importPKCS8,
  importSPKI,
  jwtVerify,
  JWTPayload,
  KeyLike,
  SignJWT,
} from 'jose';

const REVOKED_JTI_SET_KEY = 'oidc:revoked:jti';
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface TokenPrincipal {
  role: AppRole;
  ngoId?: string | null;
  apiKeyId?: string;
}

export interface VerifiedToken {
  payload: JWTPayload & {
    jti: string;
    role: AppRole;
    token_use: 'access' | 'refresh';
    ngoId?: string | null;
    apiKeyId?: string;
  };
  principal: TokenPrincipal;
}

export interface IssuedTokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_expires_in: number;
}

@Injectable()
export class TokenService {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlSeconds: number;
  private privateKeyPromise?: Promise<KeyLike>;
  private publicKeyPromise?: Promise<KeyLike>;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    this.issuer =
      this.configService.get<string>('JWT_ISSUER') ?? 'chainforge-api';
    this.audience =
      this.configService.get<string>('JWT_AUDIENCE') ?? 'chainforge-api';
    this.accessTokenTtlSeconds = this.readPositiveInt(
      'JWT_ACCESS_TOKEN_TTL_SECONDS',
      DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    );
    this.refreshTokenTtlSeconds = this.readPositiveInt(
      'JWT_REFRESH_TOKEN_TTL_SECONDS',
      DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
    );
  }

  async issueForClientCredentials(
    apiKey: string | undefined,
  ): Promise<IssuedTokenPair> {
    if (!apiKey) {
      throw new UnauthorizedException('Missing client credentials');
    }

    const principal = await this.authenticateApiKey(apiKey);
    return this.issueTokenPair(principal);
  }

  async refresh(refreshToken: string | undefined): Promise<IssuedTokenPair> {
    if (!refreshToken) {
      throw new BadRequestException('Missing refresh_token');
    }

    const verified = await this.verifyToken(refreshToken, 'refresh');
    await this.revokeVerified(verified);
    return this.issueTokenPair(verified.principal);
  }

  async verifyAccessToken(token: string): Promise<VerifiedToken> {
    return this.verifyToken(token, 'access');
  }

  async introspect(token: string): Promise<Record<string, unknown>> {
    try {
      const verified = await this.verifyToken(token);
      return {
        active: true,
        sub: verified.payload.sub,
        iss: verified.payload.iss,
        aud: verified.payload.aud,
        exp: verified.payload.exp,
        iat: verified.payload.iat,
        jti: verified.payload.jti,
        role: verified.payload.role,
        token_use: verified.payload.token_use,
        ngoId: verified.payload.ngoId,
        apiKeyId: verified.payload.apiKeyId,
      };
    } catch {
      return { active: false };
    }
  }

  async revoke(token: string): Promise<boolean> {
    try {
      const verified = await this.verifyToken(token, undefined, false);
      await this.revokeVerified(verified);
      return true;
    } catch {
      return false;
    }
  }

  async isRevoked(jti: string): Promise<boolean> {
    await this.cleanupExpiredRevocations();
    const score = await this.redis.getClient().zscore(REVOKED_JTI_SET_KEY, jti);
    return score !== null;
  }

  private async issueTokenPair(
    principal: TokenPrincipal,
  ): Promise<IssuedTokenPair> {
    const [accessToken, refreshToken] = await Promise.all([
      this.signToken(principal, 'access', this.accessTokenTtlSeconds),
      this.signToken(principal, 'refresh', this.refreshTokenTtlSeconds),
    ]);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: this.accessTokenTtlSeconds,
      refresh_expires_in: this.refreshTokenTtlSeconds,
    };
  }

  private async authenticateApiKey(
    rawClientSecret: string,
  ): Promise<TokenPrincipal> {
    const apiKeyHash = fingerprintApiKey(rawClientSecret);
    const record = await this.prisma.apiKey.findFirst({
      where: {
        revokedAt: null,
        OR: [{ keyHash: apiKeyHash }, { key: rawClientSecret }],
      },
    });

    if (record) {
      await this.prisma.apiKey.update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      });

      return {
        role: record.role,
        ngoId: record.ngoId,
        apiKeyId: record.id,
      };
    }

    const envKey = this.configService.get<string>('API_KEY');
    if (rawClientSecret === envKey) {
      return { role: AppRole.admin };
    }

    throw new UnauthorizedException('Invalid client credentials');
  }

  private async signToken(
    principal: TokenPrincipal,
    tokenUse: 'access' | 'refresh',
    ttlSeconds: number,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ttlSeconds;
    const subject = principal.apiKeyId ?? `role:${principal.role}`;

    return new SignJWT({
      role: principal.role,
      token_use: tokenUse,
      ngoId: principal.ngoId,
      apiKeyId: principal.apiKeyId,
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(subject)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .sign(await this.getPrivateKey());
  }

  private async verifyToken(
    token: string,
    expectedUse?: 'access' | 'refresh',
    enforceRevocation = true,
  ): Promise<VerifiedToken> {
    try {
      const { payload } = await jwtVerify(token, await this.getPublicKey(), {
        issuer: this.issuer,
        audience: this.audience,
      });
      const typed = payload as VerifiedToken['payload'];

      if (!typed.jti || !typed.role || !typed.token_use) {
        throw new UnauthorizedException('Invalid token claims');
      }
      if (!Object.values(AppRole).includes(typed.role)) {
        throw new UnauthorizedException('Invalid role claim');
      }
      if (expectedUse && typed.token_use !== expectedUse) {
        throw new UnauthorizedException('Invalid token use');
      }
      if (enforceRevocation && (await this.isRevoked(typed.jti))) {
        throw new UnauthorizedException('Token has been revoked');
      }

      return {
        payload: typed,
        principal: {
          role: typed.role,
          ngoId: typed.ngoId,
          apiKeyId: typed.apiKeyId,
        },
      };
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException('Invalid token');
    }
  }

  private async revokeVerified(verified: VerifiedToken): Promise<void> {
    const exp = verified.payload.exp;
    if (!exp) return;
    await this.cleanupExpiredRevocations();
    await this.redis
      .getClient()
      .zadd(REVOKED_JTI_SET_KEY, String(exp), verified.payload.jti);
  }

  private async cleanupExpiredRevocations(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.redis.getClient().zremrangebyscore(REVOKED_JTI_SET_KEY, 0, now);
  }

  private async getPrivateKey(): Promise<KeyLike> {
    this.privateKeyPromise ??= importPKCS8(
      this.readPem('JWT_PRIVATE_KEY'),
      'RS256',
    );
    return this.privateKeyPromise;
  }

  private async getPublicKey(): Promise<KeyLike> {
    this.publicKeyPromise ??= importSPKI(
      this.readPem('JWT_PUBLIC_KEY'),
      'RS256',
    );
    return this.publicKeyPromise;
  }

  private readPem(name: string): string {
    const raw = this.configService.get<string>(name);
    if (!raw) {
      throw new Error(`${name} is required for OIDC JWT support`);
    }
    return raw.replace(/\\n/g, '\n');
  }

  private readPositiveInt(name: string, fallback: number): number {
    const raw = this.configService.get<string>(name);
    const parsed = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}

// codeql[js/insufficient-password-hash]
function fingerprintApiKey(rawClientSecret: string): string {
  // SHA-256 fingerprint of a high-entropy API key/client secret for
  // exact-match lookup (matches ApiKeyGuard and ApiKey.keyHash).

  // codeql[js/insufficient-password-hash]
  return createHash('sha256').update(rawClientSecret).digest('hex');
}
