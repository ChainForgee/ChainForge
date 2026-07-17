import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../cache/redis.service';
import { PiiScrubInterceptor } from '../src/common/interceptors/pii-scrub.interceptor';
import {
  ExecutionContext,
  CallHandler,
  UnprocessableEntityException,
} from '@nestjs/common';
import { of } from 'rxjs';
import axios from 'axios';

jest.mock('axios');

describe('PiiScrubInterceptor', () => {
  let interceptor: PiiScrubInterceptor;
  let redisService: jest.Mocked<RedisService>;

  const mockConfig: Record<string, string> = {
    PII_SCRUB_MODE: 'redact',
    PII_HIGH_RISK_KEYS:
      'email,phone,name,nin,recipientRef,metadata,content,input,output',
    AI_SERVICE_URL: 'http://localhost:8000',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PiiScrubInterceptor,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => mockConfig[key]),
          },
        },
        {
          provide: RedisService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
          },
        },
      ],
    }).compile();

    interceptor = module.get<PiiScrubInterceptor>(PiiScrubInterceptor);
    redisService = module.get(RedisService);

    // Reset mocks
    jest.clearAllMocks();
  });

  const createMockContext = (body: any, user?: any): ExecutionContext => {
    const req = { body, user };
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({}),
      }),
      getType: () => 'http',
      getClass: () => ({}),
      getHandler: () => ({}),
    } as unknown as ExecutionContext;
  };

  const mockCallHandler: CallHandler = {
    handle: () => of('next-called'),
  };

  describe('PII scrubbing - redact mode', () => {
    it('should redact common PII patterns in high-risk keys', async () => {
      redisService.get.mockResolvedValue(null);
      (axios.get as jest.Mock).mockRejectedValue(
        new Error('AI service offline'),
      ); // Force fallback to default patterns

      const body = {
        metadata: {
          recipientEmail: 'john.doe@example.com',
          phone_number: '+234 803 123 4567',
          notes: 'This is fine.',
        },
        campaignName: 'Clean Water Project', // not high risk key
        otherField: 'jane.smith@example.com', // not high risk key
      };

      const context = createMockContext(body);
      await interceptor.intercept(context, mockCallHandler);

      const req = context.switchToHttp().getRequest();
      expect(req.body.metadata.recipientEmail).toBe('[EMAIL_ADDRESS]');
      expect(req.body.metadata.phone_number).toBe('[PHONE_NUMBER]');
      expect(req.body.metadata.notes).toBe('This is fine.');
      expect(req.body.campaignName).toBe('Clean Water Project'); // untouched
      expect(req.body.otherField).toBe('jane.smith@example.com'); // untouched since key is not high risk
    });

    it('should handle deep nesting and arrays', async () => {
      redisService.get.mockResolvedValue(null);
      (axios.get as jest.Mock).mockRejectedValue(
        new Error('AI service offline'),
      );

      const body = {
        metadata: {
          nested: {
            email: 'test@example.com',
          },
          list: [{ name: 'John Doe' }, { phone: '+2348031234567' }],
        },
      };

      const context = createMockContext(body);
      await interceptor.intercept(context, mockCallHandler);

      const req = context.switchToHttp().getRequest();
      expect(req.body.metadata.nested.email).toBe('[EMAIL_ADDRESS]');
      expect(req.body.metadata.list[0].name).toBe('[RECIPIENT_NAME]');
      expect(req.body.metadata.list[1].phone).toBe('[PHONE_NUMBER]');
    });
  });

  describe('PII scrubbing - reject mode', () => {
    beforeEach(() => {
      mockConfig.PII_SCRUB_MODE = 'reject';
    });

    afterEach(() => {
      mockConfig.PII_SCRUB_MODE = 'redact';
    });

    it('should throw 422 Unprocessable Entity Listing all offending paths', async () => {
      redisService.get.mockResolvedValue(null);
      (axios.get as jest.Mock).mockRejectedValue(
        new Error('AI service offline'),
      );

      const body = {
        metadata: {
          recipientEmail: 'bad@example.com',
          phone: '08031234567',
        },
        recipientRef: '99999999999', // matches NIN pattern
      };

      const context = createMockContext(body);
      await expect(
        interceptor.intercept(context, mockCallHandler),
      ).rejects.toThrow(UnprocessableEntityException);

      try {
        await interceptor.intercept(context, mockCallHandler);
      } catch (err: any) {
        expect(err.getStatus()).toBe(422);
        const response = err.getResponse();
        expect(response.errors).toContain('metadata.recipientEmail');
        expect(response.errors).toContain('metadata.phone');
        expect(response.errors).toContain('recipientRef');
      }
    });
  });

  describe('PII scrubbing - off mode', () => {
    beforeEach(() => {
      mockConfig.PII_SCRUB_MODE = 'off';
    });

    afterEach(() => {
      mockConfig.PII_SCRUB_MODE = 'redact';
    });

    it('should not redact or reject when scrub mode is off', async () => {
      const body = {
        metadata: {
          recipientEmail: 'test@example.com',
        },
      };

      const context = createMockContext(body);
      await interceptor.intercept(context, mockCallHandler);

      const req = context.switchToHttp().getRequest();
      expect(req.body.metadata.recipientEmail).toBe('test@example.com');
    });
  });

  describe('Allowlist / JWT subject bypass', () => {
    it('should bypass scrubbing for recipientRef if it matches request user ID/subject', async () => {
      redisService.get.mockResolvedValue(null);
      (axios.get as jest.Mock).mockRejectedValue(
        new Error('AI service offline'),
      );

      const body = {
        recipientRef: 'user-jwt-subject-123',
        metadata: {
          recipientEmail: 'john@example.com', // still scrubbed
        },
      };

      // Mock user is authenticated with sub = 'user-jwt-subject-123'
      const context = createMockContext(body, { sub: 'user-jwt-subject-123' });
      await interceptor.intercept(context, mockCallHandler);

      const req = context.switchToHttp().getRequest();
      expect(req.body.recipientRef).toBe('user-jwt-subject-123'); // bypassed PII scrub
      expect(req.body.metadata.recipientEmail).toBe('[EMAIL_ADDRESS]'); // still scrubbed
    });
  });

  describe('Patterns source caching and refresh', () => {
    it('should fetch from Redis if available', async () => {
      const mockPatterns = {
        email: ['[a-z]+@[a-z]+\\.com'],
      };
      redisService.get.mockResolvedValue(mockPatterns);

      const body = {
        email: 'hello@world.com',
      };

      const context = createMockContext(body);
      await interceptor.intercept(context, mockCallHandler);

      const req = context.switchToHttp().getRequest();
      expect(redisService.get).toHaveBeenCalledWith('pii:patterns');
      expect(axios.get).not.toHaveBeenCalled();
      expect(req.body.email).toBe('[EMAIL_ADDRESS]');
    });

    it('should fetch from AI Service and cache in Redis on Redis cache miss', async () => {
      redisService.get.mockResolvedValue(null);
      const mockPatterns = {
        email: ['[a-z]+@[a-z]+\\.com'],
      };
      (axios.get as jest.Mock).mockResolvedValue({ data: mockPatterns });

      const body = {
        email: 'hello@world.com',
      };

      const context = createMockContext(body);
      await interceptor.intercept(context, mockCallHandler);

      const req = context.switchToHttp().getRequest();
      expect(redisService.get).toHaveBeenCalledWith('pii:patterns');
      expect(axios.get).toHaveBeenCalledWith(
        'http://localhost:8000/api/v1/pii/patterns',
        { timeout: 3000 },
      );
      expect(redisService.set).toHaveBeenCalledWith(
        'pii:patterns',
        mockPatterns,
        3600,
      );
      expect(req.body.email).toBe('[EMAIL_ADDRESS]');
    });
  });
});
