import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { RedisService } from '@liaoliaots/nestjs-redis';
import { MetricsModule } from '../src/observability/metrics/metrics.module';
import { AuditModule } from '../src/audit/audit.module';
import { AuditService } from '../src/audit/audit.service';
import { UsageTrackerService } from '../src/observability/usage-tracker/usage-tracker.service';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const mockRedisClient = {
  multi: jest.fn(() => ({
    zadd: jest.fn().mockReturnThis(),
    zremrangebyscore: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(['OK', 0, 1] as any),
  })),
  zadd: jest.fn().mockResolvedValue(1),
  zremrangebyscore: jest.fn().mockResolvedValue(0),
  expire: jest.fn().mockResolvedValue(1),
  keys: jest.fn().mockResolvedValue([] as string[]),
  zrangebyscore: jest.fn().mockResolvedValue([] as string[]),
  zcount: jest.fn().mockResolvedValue(5),
  zcard: jest.fn().mockResolvedValue(0),
  del: jest.fn().mockResolvedValue(1),
};

const mockRedis = {
  getOrThrow: jest.fn(() => mockRedisClient),
};

const mockAuditService = {
  record: jest.fn().mockResolvedValue({ id: 'audit-1' }),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SecurityEvents (e2e)', () => {
  let usageTracker: UsageTrackerService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        MetricsModule,
        AuditModule,
      ],
      providers: [
        UsageTrackerService,
        { provide: RedisService, useValue: mockRedis },
      ],
    })
      .overrideProvider(AuditService)
      .useValue(mockAuditService)
      .compile();

    usageTracker = module.get<UsageTrackerService>(UsageTrackerService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Record usage ──────────────────────────────────────────────────────

  it('records a usage observation via Redis sorted set', async () => {
    await usageTracker.recordUsage('key-1', 'org-1', 'US');
    expect(mockRedisClient.multi).toHaveBeenCalled();
  });

  // ── No anomaly for single-country usage ───────────────────────────────

  it('does not flag an anomaly when all requests come from one country', async () => {
    mockRedisClient.keys.mockResolvedValue(['usage:key-1:15m']);
    const now = Date.now();
    const members = Array.from({ length: 10 }, (_, i) => `US:${now - i * 1000}`);
    mockRedisClient.zrangebyscore.mockResolvedValue(members);

    const anomalies = await usageTracker.getAnomalies();
    expect(anomalies).toHaveLength(0);
  });

  // ── Anomaly for multi-country usage ───────────────────────────────────

  it('flags an anomaly when requests come from >3 distinct countries', async () => {
    mockRedisClient.keys.mockResolvedValue(['usage:key-2:15m']);
    const now = Date.now();
    const countries = ['US', 'CN', 'RU', 'IR'];
    const members = countries.map((cc, i) => `${cc}:${now - i * 1000}`);
    mockRedisClient.zrangebyscore.mockResolvedValue(members);

    const anomalies = await usageTracker.getAnomalies();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].keyId).toBe('key-2');
    expect(anomalies[0].distinctCountries).toBe(4);
  });

  // ── detectAndReportAnomalies writes to AuditLog ───────────────────────

  it('writes an anomaly to the AuditLog via detectAndReportAnomalies', async () => {
    mockRedisClient.keys.mockResolvedValue(['usage:key-3:15m']);
    const now = Date.now();
    const countries = ['US', 'CN', 'RU', 'IR', 'KP'];
    const members = countries.map((cc, i) => `${cc}:${now - i * 1000}`);
    mockRedisClient.zrangebyscore.mockResolvedValue(members);
    mockRedisClient.zcard.mockResolvedValue(0);

    await usageTracker.detectAndReportAnomalies();

    expect(mockAuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'ApiKey',
        action: 'api_key_anomaly',
      }),
    );
  });

  // ── flush expired windows ─────────────────────────────────────────────

  it('cleans up empty windows during flushExpired', async () => {
    mockRedisClient.keys.mockResolvedValue(['usage:key-4:15m']);
    mockRedisClient.zcard.mockResolvedValue(0);

    await usageTracker.flushExpired();
    expect(mockRedisClient.del).toHaveBeenCalledWith('usage:key-4:15m');
  });

  // ── Edge case: no keys in Redis ───────────────────────────────────────

  it('handles empty Redis gracefully', async () => {
    mockRedisClient.keys.mockResolvedValue([]);

    const anomalies = await usageTracker.getAnomalies();
    expect(anomalies).toHaveLength(0);

    await expect(usageTracker.flushExpired()).resolves.not.toThrow();
  });

  // ── Edge case: single request should not flag anomaly ─────────────────

  it('does not flag anomaly for a single request', async () => {
    mockRedisClient.keys.mockResolvedValue(['usage:key-5:15m']);
    mockRedisClient.zrangebyscore.mockResolvedValue(['US:1234567890']);

    const anomalies = await usageTracker.getAnomalies();
    expect(anomalies).toHaveLength(0);
  });
});
