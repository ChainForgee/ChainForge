import { LoggerService } from './logger.service';
import { redactLogData } from './log-redaction.util';

describe('LoggerService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe('output format selection', () => {
    it('constructs successfully in production mode (JSON path)', () => {
      process.env.NODE_ENV = 'production';
      expect(() => new LoggerService()).not.toThrow();
    });

    it('constructs successfully in test mode (avoids jest hanging on pino-pretty worker)', () => {
      process.env.NODE_ENV = 'test';
      expect(() => new LoggerService()).not.toThrow();
    });

    it('constructs successfully in development mode (pino-pretty transport)', () => {
      process.env.NODE_ENV = 'development';
      expect(() => new LoggerService()).not.toThrow();
    });

    it('constructs successfully when NODE_ENV is unset (defaults to development)', () => {
      delete process.env.NODE_ENV;
      expect(() => new LoggerService()).not.toThrow();
    });
  });

  describe('redaction integration', () => {
    it('passes redacted meta to the underlying pino logger', () => {
      process.env.NODE_ENV = 'production';
      process.env.LOG_LEVEL = 'info';

      const service = new LoggerService();
      const infoSpy = jest.spyOn(service.getLogger(), 'info');

      service.log('login attempt', 'AuthService', {
        username: 'gooduser',
        password: 'supersecret',
        token: 'jwt-token',
        nested: {
          authorization: 'Bearer xyz',
          apikey: 'k-1234',
          social: 'public-info',
        },
      });

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const call = infoSpy.mock.calls[0] as [
        Record<string, unknown>,
        ...unknown[],
      ];
      const metaArg = call[0];
      // redacted by logger.service redactor (applied before pino):
      expect(metaArg.password).toBe('[REDACTED]');
      expect(metaArg.token).toBe('[REDACTED]');
      expect(metaArg.username).toBe('gooduser');
      const nested = metaArg.nested as Record<string, string>;
      expect(nested.authorization).toBe('[REDACTED]');
      expect(nested.apikey).toBe('[REDACTED]');
      expect(nested.social).toBe('public-info');
    });

    it('does not throw when meta contains circular structures', () => {
      process.env.NODE_ENV = 'production';
      const service = new LoggerService();

      const obj: Record<string, unknown> = { foo: 'bar' };
      obj.self = obj;

      expect(() => service.log('Trying circular', 'Spec', obj)).not.toThrow();
    });

    it('exercises redactLogData utility directly', () => {
      const redacted = redactLogData({
        password: 'p',
        token: 't',
        authorization: 'a',
        api_key: 'k',
        sleuthing: 'shh',
        deeper: { ssn: '111-22-3333', ok: 'safe' },
      }) as Record<string, Record<string, string>>;
      expect(redacted.password).toBe('[REDACTED]');
      expect(redacted.token).toBe('[REDACTED]');
      expect(redacted.authorization).toBe('[REDACTED]');
      expect(redacted.api_key).toBe('[REDACTED]');
      expect(redacted.sleuthing).toBe('shh');
      expect(redacted.deeper.ssn).toBe('[REDACTED]');
      expect(redacted.deeper.ok).toBe('safe');
    });
  });

  describe('correlation ID propagation', () => {
    it('adds correlationId when async storage is populated', () => {
      process.env.NODE_ENV = 'production';
      process.env.LOG_LEVEL = 'info';

      const service = new LoggerService();
      const als = service.getAsyncLocalStorage();
      const infoSpy = jest.spyOn(service.getLogger(), 'info');

      als.run(new Map([['correlationId', 'corr-xyz-789']]), () => {
        service.log('inside correlation', 'Spec', { user: 'u' });
      });

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const call = infoSpy.mock.calls[0] as [
        Record<string, unknown>,
        ...unknown[],
      ];
      const metaArg = call[0];
      expect(metaArg.correlationId).toBe('corr-xyz-789');
      expect(metaArg.user).toBe('u');
    });
  });

  describe('log level configuration via LOG_LEVEL env', () => {
    it('suppresses info when LOG_LEVEL=warn', () => {
      process.env.NODE_ENV = 'production';
      process.env.LOG_LEVEL = 'warn';

      const service = new LoggerService();
      const infoSpy = jest.spyOn(service.getLogger(), 'info');
      const warnSpy = jest.spyOn(service.getLogger(), 'warn');

      service.log('should be suppressed (info)', 'Spec');
      service.warn('should be visible (warn)', 'Spec');

      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('defaults to info level when LOG_LEVEL is unset', () => {
      delete process.env.LOG_LEVEL;
      process.env.NODE_ENV = 'production';

      const service = new LoggerService();
      const infoSpy = jest.spyOn(service.getLogger(), 'info');

      service.log('visible by default', 'Spec');
      expect(infoSpy).toHaveBeenCalledTimes(1);
    });
  });
});
