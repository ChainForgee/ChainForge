import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../../cache/redis.service';
import axios from 'axios';

interface CompiledPattern {
  label: string;
  regex: RegExp;
}

const DEFAULT_PATTERNS: Record<string, string[]> = {
  email: ['\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b'],
  phone: [
    '\\+?\\d{1,4}[-.\\s]?\\(?\\d{1,3}?\\)?[-.\\s]?\\d{3}[-.\\s]?\\d{4}\\b',
    '\\b0\\d{10}\\b',
    '\\+234\\s?\\d{3}\\s?\\d{3}\\s?\\d{4}\\b',
  ],
  name: [
    '\\b(?:Mr|Mrs|Ms|Miss|Dr|Prof)\\.?\\s+[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2}\\b',
    '\\b[A-Z][a-z]+\\s+[A-Z][a-z]+\\b',
  ],
  location: [
    '\\b(?:in|at|from|near)\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2}(?:\\s+(?:Camp|State|Region|District|City|Village|Way|Island))?)\\b',
    '\\d+\\s+[A-Z][a-z]+\\s+[A-Z][a-z]+\\s+(?:Way|Street|Avenue|Road|Island)\\b',
  ],
  date: [
    '\\b\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}\\b',
    '\\b\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}\\b',
    '\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\s+\\d{1,2},?\\s+\\d{4}\\b',
    '\\b\\d{1,2}\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\s+\\d{4}\\b',
  ],
  id: [
    '\\b\\d{11}\\b', // NIN
    '\\b[A-Z]{2}\\d{8}\\b', // Voter ID
  ],
};

const MAP_KEY_TO_TOKEN: Record<string, string> = {
  email: 'EMAIL_ADDRESS',
  phone: 'PHONE_NUMBER',
  name: 'RECIPIENT_NAME',
  location: 'LOCATION',
  date: 'EVENT_DATE',
  id: 'ID_NUMBER',
};

@Injectable()
export class PiiScrubInterceptor implements NestInterceptor {
  private cachedPatterns: CompiledPattern[] | null = null;
  private lastFetchedMemoryTime = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    if (!request || !request.body || typeof request.body !== 'object') {
      return next.handle();
    }

    const mode = this.configService.get<string>('PII_SCRUB_MODE') || 'redact';
    if (mode === 'off') {
      return next.handle();
    }

    const highRiskKeysConfig =
      this.configService.get<string>('PII_HIGH_RISK_KEYS');
    const highRiskKeys = highRiskKeysConfig
      ? highRiskKeysConfig.split(',').map(k => k.trim())
      : [
          'email',
          'phone',
          'name',
          'nin',
          'recipientref',
          'metadata',
          'content',
          'input',
          'output',
        ];

    const userSub =
      request.user?.sub || request.user?.id || request.user?.apiKeyId;
    const patterns = await this.getCompiledPatterns();

    const offendingPaths: string[] = [];

    const traverseAndScrub = (obj: any, path = ''): any => {
      if (obj === null || obj === undefined) return obj;

      if (Array.isArray(obj)) {
        return obj.map((item, index) =>
          traverseAndScrub(item, path ? `${path}[${index}]` : `[${index}]`),
        );
      }

      if (typeof obj === 'object') {
        const result: any = {};
        for (const key of Object.keys(obj)) {
          const val = obj[key];
          const currentPath = path ? `${path}.${key}` : key;
          const isHighRisk = this.checkIsHighRiskKey(key, highRiskKeys);

          if (isHighRisk && typeof val === 'string') {
            // Check allowlist: if val matches userSub, skip scrubbing
            if (userSub && String(val) === String(userSub)) {
              result[key] = val;
            } else {
              const matches = this.checkPiiMatches(val, patterns);
              if (matches.length > 0) {
                if (mode === 'reject') {
                  offendingPaths.push(currentPath);
                  result[key] = val; // keep original for completeness
                } else {
                  // redact mode
                  result[key] = this.redactPii(val, patterns);
                }
              } else {
                result[key] = val;
              }
            }
          } else {
            result[key] = traverseAndScrub(val, currentPath);
          }
        }
        return result;
      }

      return obj;
    };

    request.body = traverseAndScrub(request.body);

    if (offendingPaths.length > 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        message: `PII validation failed: offending field paths contain PII: ${offendingPaths.join(', ')}`,
        errors: offendingPaths,
      });
    }

    return next.handle();
  }

  private checkIsHighRiskKey(key: string, highRiskKeys: string[]): boolean {
    const lowerKey = key.toLowerCase();
    return highRiskKeys.some(k => {
      const lowerK = k.toLowerCase();
      if (lowerK === 'name') {
        return (
          lowerKey === 'name' ||
          lowerKey === 'fullname' ||
          lowerKey === 'firstname' ||
          lowerKey === 'lastname' ||
          lowerKey === 'recipientname' ||
          lowerKey === 'username' ||
          (lowerKey.endsWith('name') &&
            !lowerKey.includes('campaign') &&
            !lowerKey.includes('org') &&
            !lowerKey.includes('app'))
        );
      }
      return (
        lowerKey === lowerK ||
        lowerKey.endsWith(lowerK) ||
        lowerKey.startsWith(lowerK) ||
        lowerKey.includes('_' + lowerK) ||
        lowerKey.includes(lowerK + '_')
      );
    });
  }

  private checkPiiMatches(
    val: string,
    patterns: CompiledPattern[],
  ): CompiledPattern[] {
    const matched: CompiledPattern[] = [];
    for (const pattern of patterns) {
      // Reset lastIndex for safety when reusing RegExp with global flag
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(val)) {
        matched.push(pattern);
      }
    }
    return matched;
  }

  private redactPii(val: string, patterns: CompiledPattern[]): string {
    let scrubbed = val;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      scrubbed = scrubbed.replace(pattern.regex, `[${pattern.label}]`);
    }
    return scrubbed;
  }

  private async getCompiledPatterns(): Promise<CompiledPattern[]> {
    const now = Date.now();
    if (this.cachedPatterns && now - this.lastFetchedMemoryTime < 60000) {
      return this.cachedPatterns;
    }

    // Try Redis
    try {
      const redisPatterns =
        await this.redisService.get<Record<string, string[]>>('pii:patterns');
      if (redisPatterns) {
        this.cachedPatterns = this.compilePatterns(redisPatterns);
        this.lastFetchedMemoryTime = now;
        return this.cachedPatterns;
      }
    } catch {
      // Log / fallback silently
    }

    // Try AI Service
    const aiServiceUrl =
      this.configService.get<string>('AI_SERVICE_URL') ||
      'http://localhost:8000';
    try {
      const response = await axios.get(`${aiServiceUrl}/api/v1/pii/patterns`, {
        timeout: 3000,
      });
      if (response.data && typeof response.data === 'object') {
        const fetched = response.data as Record<string, string[]>;
        this.cachedPatterns = this.compilePatterns(fetched);
        this.lastFetchedMemoryTime = now;
        try {
          await this.redisService.set('pii:patterns', fetched, 3600);
        } catch {
          // Redis set fail is non-fatal
        }
        return this.cachedPatterns;
      }
    } catch {
      // AI Service offline or slow
    }

    // Fallback to defaults
    this.cachedPatterns = this.compilePatterns(DEFAULT_PATTERNS);
    // Set memory refresh time slightly shorter in failure mode so we retry in 10s
    this.lastFetchedMemoryTime = now - 50000;
    return this.cachedPatterns;
  }

  private compilePatterns(raw: Record<string, string[]>): CompiledPattern[] {
    const compiled: CompiledPattern[] = [];
    for (const [key, patterns] of Object.entries(raw)) {
      const label = MAP_KEY_TO_TOKEN[key] || 'PII';
      for (const pattern of patterns) {
        try {
          compiled.push({
            label,
            regex: new RegExp(pattern, 'g'),
          });
        } catch {
          // Skip invalid patterns
        }
      }
    }
    return compiled;
  }
}
