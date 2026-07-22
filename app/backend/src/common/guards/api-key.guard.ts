import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { AppRole } from '../../auth/app-role.enum';
import {
  maskApiKeyPreview,
  verifyApiKeyHash,
} from '../../api-keys/api-key-hash.util';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const apiKeyHeader = request.headers['x-api-key'];
    const apiKey =
      typeof apiKeyHeader === 'string'
        ? apiKeyHeader
        : Array.isArray(apiKeyHeader)
          ? apiKeyHeader[0]
          : undefined;

    if (!apiKey) {
      throw new UnauthorizedException('Invalid or missing API key');
    }

    const activeKeys = await this.prisma.apiKey.findMany({
      where: {
        revokedAt: null,
        keyPreview: maskApiKeyPreview(apiKey),
        keyHash: { not: null },
      },
      select: {
        id: true,
        keyHash: true,
        role: true,
        ngoId: true,
      },
    });
    const record = (
      await Promise.all(
        activeKeys.map(async candidate =>
          (await verifyApiKeyHash(candidate.keyHash, apiKey))
            ? candidate
            : undefined,
        ),
      )
    ).find(Boolean);

    if (record) {
      // Record usage for lifecycle visibility (best-effort, but awaited to ensure consistency in tests)
      await this.prisma.apiKey.update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      });

      request.user = {
        role: record.role,
        ngoId: record.ngoId,
        apiKeyId: record.id,
        authType: 'apiKey',
      };
      return true;
    }

    // Backward-compatibility fallback: if no DB record exists but the key
    // matches the env-var API_KEY, treat the caller as admin.
    const envKey = this.configService.get<string>('API_KEY');
    if (apiKey === envKey) {
      request.user = { role: AppRole.admin, authType: 'envApiKey' };
      return true;
    }

    throw new UnauthorizedException('Invalid or missing API key');
  }
}
