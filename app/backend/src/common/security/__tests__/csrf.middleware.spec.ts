import { CsrfMiddleware, generateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '../csrf.middleware';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

const createMockConfig = (csrfEnabled: string, nodeEnv = 'test'): jest.Mocked<ConfigService> =>
  ({
    get: jest.fn(<T = any>(key: string, defaultValue?: T): T | undefined => {
      if (key === 'CSRF_PROTECTION_ENABLED') return csrfEnabled as unknown as T;
      if (key === 'NODE_ENV') return nodeEnv as unknown as T;
      return defaultValue;
    }),
  }) as unknown as jest.Mocked<ConfigService>;

const createReq = (overrides: Partial<Request> = {}): Partial<Request> => {
  const req: Partial<Request> & { cookies?: Record<string, string> } = {
    method: 'GET',
    path: '/api/v1/test',
    headers: {},
    cookies: {},
    ...overrides,
  };
  return req;
};

const createRes = (): Partial<Response> => {
  const res: Partial<Response> & { headers: Record<string, string> } = {
    headers: {},
    cookie: jest.fn().mockImplementation(function(this: any, name: string, _val: string, _opts?: any) {
      this.headers[name] = _val;
    }),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as any;
  return res;
};

const createNext = (): jest.Mock => jest.fn();

describe('CsrfMiddleware', () => {
  describe('when CSRF_PROTECTION_ENABLED=false (default)', () => {
    it('should pass through without validating state-changing methods', () => {
      const config = createMockConfig('false');
      const middleware = new CsrfMiddleware(config as unknown as ConfigService);
      const req = createReq({ method: 'POST' }) as Request;
      const res = createRes() as Response;
      const next = createNext();
      middleware.use(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should set a csrf-token cookie if none exists', () => {
      const config = createMockConfig('false');
      const middleware = new CsrfMiddleware(config as unknown as ConfigService);
      const req = createReq() as Request;
      const res = createRes() as Response;
      const next = createNext();
      middleware.use(req, res, next);
      expect(res.cookie).toHaveBeenCalledWith(CSRF_COOKIE_NAME, expect.any(String), expect.objectContaining({ httpOnly: true, path: '/' }));
      expect(next).toHaveBeenCalled();
    });
  });

  describe('when CSRF_PROTECTION_ENABLED=true', () => {
    it('should set token cookie on GET requests and call next', () => {
      const config = createMockConfig('true');
      const middleware = new CsrfMiddleware(config as unknown as ConfigService);
      const req = createReq({ method: 'GET' }) as Request;
      const res = createRes() as Response;
      const next = createNext();
      middleware.use(req, res, next);
      expect(res.cookie).toHaveBeenCalledWith(CSRF_COOKIE_NAME, expect.any(String), expect.any(Object));
      expect(next).toHaveBeenCalled();
    });

    it('should reuse existing token cookie on GET if already present', () => {
      const config = createMockConfig('true');
      const middleware = new CsrfMiddleware(config as unknown as ConfigService);
      const existingToken = generateCsrfToken();
      const req = createReq({ method: 'GET', cookies: { [CSRF_COOKIE_NAME]: existingToken } }) as Request;
      const res = createRes() as Response;
      const next = createNext();
      middleware.use(req, res, next);
      expect(res.cookie).toHaveBeenCalledWith(CSRF_COOKIE_NAME, existingToken, expect.any(Object));
      expect(next).toHaveBeenCalled();
    });

    it('should return 403 on POST when cookie is missing', () => {
      const config = createMockConfig('true');
      const middleware = new CsrfMiddleware(config as unknown as ConfigService);
      const req = createReq({ method: 'POST', cookies: {}, headers: { [CSRF_HEADER_NAME]: 'some-token' } }) as Request;
      const res = createRes() as Response;
      const next = createNext();
      middleware.use(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'CSRF token missing' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 403 on POST when header is missing', () => {
      const config = createMockConfig('true');
      const middleware = new CsrfMiddleware(config as unknown as ConfigService);
      const token = generateCsrfToken();
      const req = createReq({ method: 'POST', cookies: { [CSRF_COOKIE_NAME]: token }, headers: {} }) as Request;
      const res = createRes() as Response;
      const next = createNext();
      middleware.use(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'CSRF token missing' }));
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 403 on POST when tokens do not match', () => {
      const config = createMockConfig('true');
      const middleware = new CsrfMiddleware(config as unknown as ConfigService);
      const req = createReq({ method: 'POST', cookies: { [CSRF_COOKIE_NAME]: generateCsrfToken() }, headers: { [CSRF_HEADER_NAME]: 'different-token-value' } }) as Request;
      const res = createRes() as Response;
      const next = createNext();
      middleware.use(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('should allow POST when cookie and header tokens match', () => {
      const config = createMockConfig('true');
      const middleware = new CsrfMiddleware(config as unknown as ConfigService);
      const token = generateCsrfToken();
      const req = createReq({ method: 'POST', cookies: { [CSRF_COOKIE_NAME]: token }, headers: { [CSRF_HEADER_NAME]: token } }) as Request;
      const res = createRes() as Response;
      const next = createNext();
      middleware.use(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should rotate token after a successful state-changing request', () => {
      const config = createMockConfig('true');
      const middleware = new CsrfMiddleware(config as unknown as ConfigService);
      const token = generateCsrfToken();
      const req = createReq({ method: 'DELETE', cookies: { [CSRF_COOKIE_NAME]: token }, headers: { [CSRF_HEADER_NAME]: token } }) as Request;
      const res = createRes() as Response;
      const next = createNext();
      middleware.use(req, res, next);
      const newTokenArg = (res.cookie as jest.Mock).mock.calls[0][1];
      expect(newTokenArg).not.toEqual(token);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('generateCsrfToken', () => {
    it('should produce a hex string of length 64 (32 bytes)', () => {
      const token = generateCsrfToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce unique values on subsequent calls', () => {
      const t1 = generateCsrfToken();
      const t2 = generateCsrfToken();
      expect(t1).not.toBe(t2);
    });
  });
});
