import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { Request } from 'express';

@Injectable()
export class AdaptiveRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(AdaptiveRateLimitGuard.name);
  private readonly limits = {
    auth: { limit: 5, window: 60 },
    search: { limit: 30, window: 60 },
    public: { limit: 10, window: 60 },
    apiKey: { limit: 100, window: 60 },
  };

  constructor(private readonly redisService: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    let client: ReturnType<RedisService['getOrThrow']> | null = null;
    try {
      client = this.redisService.getOrThrow();
    } catch {
      this.logger.warn('Redis unavailable — skipping adaptive rate limiting');
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const strategy = this.getStrategy(request);
    const { limit, window } = this.limits[strategy];
    const identifier = this.getIdentifier(request);
    const key = `ratelimit:${strategy}:${identifier}`;

    try {
      const current = await client.incr(key);
      if (current === 1) {
        await client.expire(key, window);
      }

      if (current > limit) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many requests, please try again later.',
            strategy,
            limit,
            resetIn: await client.ttl(key),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn(
        `Redis operation failed — skipping rate limit check: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return true;
  }

  private getStrategy(request: Request): keyof typeof this.limits {
    const path = (request as any).path ?? (request as any).url ?? '';
    if (path.includes('/search')) return 'search';

    const user = (request as any).user;
    if (user) {
      if (user.authType === 'apiKey' || user.authType === 'envApiKey') {
        return 'apiKey';
      }
      return 'auth';
    }

    return 'public';
  }

  private getIdentifier(request: Request): string {
    const user = (request as any).user;
    if (user?.id) return user.id as string;
    if (user?.apiKeyId) return user.apiKeyId as string;

    const ips = (request as any).ips;
    const forwardedIp =
      Array.isArray(ips) && ips.length > 0 ? (ips[0] as string) : undefined;
    return forwardedIp ?? request.ip ?? 'anonymous';
  }
}
