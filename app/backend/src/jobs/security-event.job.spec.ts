import { Test, TestingModule } from '@nestjs/testing';
import { SecurityEventJob } from './security-event.job';
import { ApiKeyUsageTrackerService } from '../observability/usage-tracker/api-key-usage-tracker.service';
import { AuditService } from '../audit/audit.service';
import { AnomalyEvent } from '../observability/usage-tracker/api-key-usage-tracker.service';

describe('SecurityEventJob', () => {
  let job: SecurityEventJob;
  let auditService: AuditService;

  const mockAnomaly: AnomalyEvent = {
    keyId: 'key-123',
    orgId: 'org-456',
    distinctCountries: 5,
    countries: ['US', 'GB', 'DE', 'FR', 'JP'],
    windowStart: new Date('2024-01-01T00:00:00Z'),
    windowEnd: new Date('2024-01-01T01:00:00Z'),
  };

  const mockUsageTracker = {
    flushAllWindows: jest.fn(),
  };

  const mockAuditService = {
    record: jest.fn().mockResolvedValue({ id: 'audit-1' }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecurityEventJob,
        {
          provide: ApiKeyUsageTrackerService,
          useValue: mockUsageTracker,
        },
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
      ],
    }).compile();

    job = module.get<SecurityEventJob>(SecurityEventJob);
    auditService = module.get<AuditService>(AuditService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(job).toBeDefined();
  });

  describe('flushUsageWindows', () => {
    it('should record audit log entries for each anomaly', async () => {
      mockUsageTracker.flushAllWindows.mockResolvedValue([mockAnomaly]);

      await job.flushUsageWindows();

      expect(auditService.record).toHaveBeenCalledTimes(1);
      expect(auditService.record).toHaveBeenCalledWith({
        actorId: 'apikey:key-123',
        entity: 'ApiKey',
        entityId: 'key-123',
        action: 'security_anomaly',
        metadata: {
          kind: 'api_key_anomaly',
          distinctCountries: 5,
          countries: ['US', 'GB', 'DE', 'FR', 'JP'],
          orgId: 'org-456',
          windowStart: '2024-01-01T00:00:00.000Z',
          windowEnd: '2024-01-01T01:00:00.000Z',
        },
      });
    });

    it('should record multiple audit entries for multiple anomalies', async () => {
      const anomaly2: AnomalyEvent = {
        ...mockAnomaly,
        keyId: 'key-789',
        orgId: null,
        distinctCountries: 4,
        countries: ['US', 'GB', 'DE', 'FR'],
      };
      mockUsageTracker.flushAllWindows.mockResolvedValue([
        mockAnomaly,
        anomaly2,
      ]);

      await job.flushUsageWindows();

      expect(auditService.record).toHaveBeenCalledTimes(2);
      expect(auditService.record).toHaveBeenNthCalledWith(1, {
        actorId: 'apikey:key-123',
        entity: 'ApiKey',
        entityId: 'key-123',
        action: 'security_anomaly',
        metadata: expect.objectContaining({ kind: 'api_key_anomaly' }),
      });
      expect(auditService.record).toHaveBeenNthCalledWith(2, {
        actorId: 'apikey:key-789',
        entity: 'ApiKey',
        entityId: 'key-789',
        action: 'security_anomaly',
        metadata: expect.objectContaining({
          orgId: null,
          distinctCountries: 4,
        }),
      });
    });

    it('should not record audit entries when no anomalies', async () => {
      mockUsageTracker.flushAllWindows.mockResolvedValue([]);

      await job.flushUsageWindows();

      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('should handle flushAllWindows errors gracefully', async () => {
      mockUsageTracker.flushAllWindows.mockRejectedValue(
        new Error('Redis connection failed'),
      );

      await expect(job.flushUsageWindows()).resolves.not.toThrow();
    });

    it('should handle auditService.record errors for individual entries', async () => {
      mockUsageTracker.flushAllWindows.mockResolvedValue([mockAnomaly]);
      mockAuditService.record.mockRejectedValueOnce(
        new Error('DB connection lost'),
      );

      await expect(job.flushUsageWindows()).resolves.not.toThrow();
    });
  });
});
