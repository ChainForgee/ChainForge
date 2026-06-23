import { Test, TestingModule } from '@nestjs/testing';
import { CspReportController } from './csp-report.controller';
import { LoggerService } from '../../logger/logger.service';
import { Public } from '../decorators/public.decorator';

describe('CspReportController', () => {
  let controller: CspReportController;
  let mockLogger: {
    warn: jest.Mock;
    error: jest.Mock;
    debug: jest.Mock;
    log: jest.Mock;
  };

  const buildReq = (body: unknown, overrides: Record<string, unknown> = {}) => {
    return {
      body,
      ip: '203.0.113.5',
      headers: {
        'user-agent': 'Mozilla/5.0 (CSP-Reporter)',
      },
      ...overrides,
    } as unknown as Parameters<CspReportController['handleReport']>[0];
  };

  const buildRes = () => {
    const res: { statusCode?: number; body?: unknown } = {};
    return {
      status: jest.fn((code: number) => {
        res.statusCode = code;
        return {
          send: jest.fn((body?: unknown) => {
            res.body = body;
          }),
        };
      }),
      _state: res,
    } as unknown as Parameters<CspReportController['handleReport']>[1] & {
      _state: { statusCode?: number; body?: unknown };
    };
  };

  beforeEach(async () => {
    mockLogger = {
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      log: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CspReportController],
      providers: [{ provide: LoggerService, useValue: mockLogger }],
    }).compile();

    controller = module.get(CspReportController);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should be marked @Public() so ApiKeyGuard bypasses it', () => {
    // The class‑level decorator attaches metadata; verify via reflection.

    const publicFlag = Reflect.getMetadata('isPublic', CspReportController);
    expect(publicFlag).toBe(true);
  });

  it('should return 204 immediately and log a single violation (legacy payload)', () => {
    const legacyPayload = {
      'csp-report': {
        'document-uri': 'https://app.example.com/page',
        'violated-directive': "script-src 'self'",
        'effective-directive': 'script-src',
        'blocked-uri': 'https://attacker.example.com/x.js',
        'source-file': 'https://app.example.com/page',
        'line-number': 12,
        'column-number': 4,
        disposition: 'enforce',
      },
    };

    const res = buildRes();

    controller.handleReport(buildReq(legacyPayload), res);

    expect(
      (res as unknown as { status: jest.Mock }).status,
    ).toHaveBeenCalledWith(204);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const [, context, meta] = mockLogger.warn.mock.calls[0];
    expect(context).toBe('CspReportController');
    expect(meta.security_event).toBe('csp_violation');
    expect(meta.violated_directive).toBe("script-src 'self'");
    expect(meta.blocked_uri).toBe('https://attacker.example.com/x.js');
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('should accept array payloads from the new Reporting API and log one warning per violation', () => {
    const reports = [
      { type: 'csp-violation', url: 'https://app.example.com/a' },
      { type: 'csp-violation', url: 'https://app.example.com/b' },
    ];

    const res = buildRes();
    controller.handleReport(buildReq(reports), res);

    expect(
      (res as unknown as { status: jest.Mock }).status,
    ).toHaveBeenCalledWith(204);
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    reports.forEach((report, index) => {
      expect(mockLogger.warn.mock.calls[index][2].document_uri).toBe(
        report.url,
      );
    });
  });

  it('should accept bare object payloads (modern browser reports)', () => {
    const payload = {
      type: 'csp-violation',
      url: 'https://app.example.com/page',
      body: {
        'blocked-uri': 'inline',
      },
    };

    const res = buildRes();
    controller.handleReport(buildReq(payload), res);

    expect(
      (res as unknown as { status: jest.Mock }).status,
    ).toHaveBeenCalledWith(204);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][2].document_uri).toBe(
      'https://app.example.com/page',
    );
  });

  it('should silently ignore empty / non‑object / null bodies but still return 204', () => {
    const res = buildRes();
    controller.handleReport(buildReq(null), res);
    expect(
      (res as unknown as { status: jest.Mock }).status,
    ).toHaveBeenCalledWith(204);
    expect(mockLogger.warn).not.toHaveBeenCalled();

    const res2 = buildRes();
    controller.handleReport(buildReq(undefined), res2);
    expect(mockLogger.warn).not.toHaveBeenCalled();

    const res3 = buildRes();
    controller.handleReport(buildReq('plain string'), res3);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('should emit an error-level spike log when threshold is reached inside the window', () => {
    // Send 24 distinct violations -- below threshold.
    for (let i = 0; i < 24; i += 1) {
      controller.handleReport(
        buildReq({ 'csp-report': { 'violated-directive': "img-src 'self'" } }),
        buildRes(),
      );
    }
    expect(mockLogger.warn).toHaveBeenCalledTimes(24);
    expect(mockLogger.error).not.toHaveBeenCalled();

    // 25th crosses the threshold and should emit the spike alert.
    controller.handleReport(
      buildReq({ 'csp-report': { 'violated-directive': "img-src 'self'" } }),
      buildRes(),
    );

    expect(mockLogger.warn).toHaveBeenCalledTimes(25);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const [, , errorMeta] = mockLogger.error.mock.calls[0];
    expect(errorMeta.security_event).toBe('csp_violation_spike');
    expect(errorMeta.count).toBe(25);
    expect(errorMeta.threshold).toBe(25);
  });

  it('should not log full script samples to limit attacker-controlled content', () => {
    const huge = 'A'.repeat(2000);
    controller.handleReport(
      buildReq({
        'csp-report': {
          'script-sample': huge,
        },
      }),
      buildRes(),
    );

    const [, , meta] = mockLogger.warn.mock.calls[0];
    expect(meta.script_sample.length).toBeLessThanOrEqual(120);
  });

  it('imports the Public decorator from the public decorator module', () => {
    // Smoke check that the decorator is wired correctly.
    expect(typeof Public).toBe('function');
  });
});
