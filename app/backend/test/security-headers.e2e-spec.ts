import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import {
  buildCorsOptions,
  createCorsOriginValidator,
  createHelmetMiddleware,
  createRateLimiter,
} from '../src/common/security/security.module';
import { RedisService } from '@liaoliaots/nestjs-redis';
import RedisMock from 'ioredis-mock';
import { Controller, Get, HttpCode } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

@Controller()
class TestController {
  @Get('health')
  @HttpCode(200)
  getHealth() {
    return { status: 'OK' };
  }

  @Get()
  @HttpCode(200)
  getRoot() {
    return { message: 'OK' };
  }
}

const createTestApp = async (): Promise<INestApplication> => {
  const mockRedisInstance = new RedisMock();
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [
      // ConfigModule is loaded via forRoot in the test; no need to import it
      // here since ConfigModule.forRoot is already configured in the test.
    ],
    controllers: [TestController],
    providers: [
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn(<T = any>(key: string, defaultValue?: T): T | undefined => {
            if (key === 'NODE_ENV') return (process.env.NODE_ENV ?? 'test') as unknown as T;
            if (key === 'CORS_ORIGINS') return (process.env.CORS_ORIGINS ?? 'http://localhost:3000') as unknown as T;
            if (key === 'CORS_ALLOW_CREDENTIALS') return (process.env.CORS_ALLOW_CREDENTIALS ?? 'false') as unknown as T;
            if (key === 'RATE_LIMIT_LIMIT' || key === 'API_RATE_LIMIT') return '1000' as unknown as T;
            if (key === 'RATE_LIMIT_WINDOW_MS' || key === 'THROTTLE_TTL') return '60000' as unknown as T;
            return defaultValue;
          }),
        },
      },
      {
        provide: RedisService,
        useValue: {
          getOrThrow: () => mockRedisInstance,
        },
      },
    ],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  const configService = app.get(ConfigService);
  app.use(createHelmetMiddleware(configService));
  app.use(createCorsOriginValidator(configService));
  app.enableCors(buildCorsOptions(configService));
  app.use(createRateLimiter(configService, app.get(RedisService)));

  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
    prefix: 'v',
  });

  await app.init();
  return app;
};

// Required security headers and their expected values (regex patterns)
// These are derived from buildHelmetOptions in security.module.ts
const REQUIRED_PRODUCTION_HEADERS: Record<string, RegExp | string> = {
  'strict-transport-security': /max-age=31536000; includeSubDomains; preload/,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'x-dns-prefetch-control': 'off',
  'x-permitted-cross-domain-policies': 'none',
  'content-security-policy': /default-src 'self'/,
};

// Headers that should be present in development mode too
const REQUIRED_DEV_HEADERS: Record<string, RegExp | string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-dns-prefetch-control': 'off',
  'x-permitted-cross-domain-policies': 'none',
};

// Headers that MUST be absent in development mode
const ABSENT_DEV_HEADERS = [
  'strict-transport-security',
  'content-security-policy',
  'cross-origin-opener-policy',
];

const setEnv = (vars: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Security Headers (e2e)', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeAll(() => {
    originalEnv = {
      NODE_ENV: process.env.NODE_ENV,
      CORS_ORIGINS: process.env.CORS_ORIGINS,
      CORS_ALLOW_CREDENTIALS: process.env.CORS_ALLOW_CREDENTIALS,
    };
  });

  afterAll(() => {
    setEnv(originalEnv);
  });

  describe('Production mode', () => {
    let app: INestApplication;

    beforeAll(async () => {
      setEnv({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://api.chainforge.app',
        CORS_ALLOW_CREDENTIALS: 'false',
      });
      app = await createTestApp();
    });

    afterAll(async () => {
      await app.close();
    });

    it('should include all required security headers with correct values', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health');

      for (const [header, expected] of Object.entries(REQUIRED_PRODUCTION_HEADERS)) {
        expect(response.headers[header]).toBeDefined();
        if (expected instanceof RegExp) {
          expect(response.headers[header]).toMatch(expected);
        } else {
          expect(response.headers[header]).toBe(expected);
        }
      }
    });

    it('should NOT include the x-powered-by header', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health');
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('should include report-uri in Content-Security-Policy header', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health');
      const csp = response.headers['content-security-policy'] as string;
      expect(csp).toBeDefined();
      // The CSP report-uri directive tells the browser where to send violation reports
      expect(csp).toContain('/api/v1/csp-report');
    });

    it('should include preload directive in Strict-Transport-Security', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health');
      const hsts = response.headers['strict-transport-security'] as string;
      expect(hsts).toBeDefined();
      expect(hsts).toContain('preload');
      expect(hsts).toContain('includeSubDomains');
      expect(hsts).toContain('max-age=31536000');
    });
  });

  describe('Development mode', () => {
    let app: INestApplication;

    beforeAll(async () => {
      setEnv({
        NODE_ENV: 'development',
        CORS_ORIGINS: 'http://localhost:3000',
        CORS_ALLOW_CREDENTIALS: 'false',
      });
      app = await createTestApp();
    });

    afterAll(async () => {
      await app.close();
    });

    it('should include dev-appropriate security headers', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health');

      for (const [header, expected] of Object.entries(REQUIRED_DEV_HEADERS)) {
        expect(response.headers[header]).toBeDefined();
        if (expected instanceof RegExp) {
          expect(response.headers[header]).toMatch(expected);
        } else {
          expect(response.headers[header]).toBe(expected);
        }
      }
    });

    it('should NOT include production-only headers in dev mode', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health');

      for (const header of ABSENT_DEV_HEADERS) {
        expect(response.headers[header]).toBeUndefined();
      }
    });

    it('should not include x-powered-by header', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health');
      expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });
});
