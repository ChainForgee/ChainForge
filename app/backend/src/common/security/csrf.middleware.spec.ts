import { createCsrfMiddleware } from './csrf.middleware';
import type { Request, Response } from 'express';

const CSRF_COOKIE_NAME = '_csrf_token';
const CSRF_HEADER_NAME = 'x-csrf-token';

const createMockRequest = (
  method = 'GET',
  cookieHeader: string | undefined = undefined,
  headers: Record<string, string> = {},
): Request =>
  ({
    method,
    headers: {
      ...headers,
      ...(cookieHeader !== undefined ? { cookie: cookieHeader } : {}),
    },
    path: '/api/v1/test',
    originalUrl: '/api/v1/test',
  }) as unknown as Request;

const createMockResponse = (): Response => {
  const res = {
    cookie: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
  return res;
};

describe('CsrfMiddleware', () => {
  let middleware: ReturnType<typeof createCsrfMiddleware>;

  beforeEach(() => {
    middleware = createCsrfMiddleware();
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  describe('Safe methods (GET, HEAD, OPTIONS)', () => {
    it('should set a CSRF cookie on GET when no existing cookie', () => {
      const req = createMockRequest('GET', undefined);
      const res = createMockResponse();
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.cookie).toHaveBeenCalledWith(
        CSRF_COOKIE_NAME,
        expect.any(String),
        expect.objectContaining({
          httpOnly: false,
          sameSite: 'strict',
        }),
      );
    });

    it('should not overwrite an existing valid CSRF cookie', () => {
      const existingToken = 'a'.repeat(64); // 32 bytes hex = 64 chars
      const cookieStr = `${CSRF_COOKIE_NAME}=${existingToken}`;
      const req = createMockRequest('GET', cookieStr);
      const res = createMockResponse();
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('should set cookie for HEAD requests', () => {
      const req = createMockRequest('HEAD', undefined);
      const res = createMockResponse();
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.cookie).toHaveBeenCalled();
    });

    it('should set cookie for OPTIONS requests', () => {
      const req = createMockRequest('OPTIONS', undefined);
      const res = createMockResponse();
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('Unsafe methods (POST, PUT, PATCH, DELETE)', () => {
    it('should reject POST when both cookie and header are missing', () => {
      const req = createMockRequest('POST', undefined, {});
      const res = createMockResponse();
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'CSRF token missing' }),
      );
    });

    it('should reject POST when cookie is present but header is missing', () => {
      const token = 'a'.repeat(64);
      const cookieStr = `${CSRF_COOKIE_NAME}=${token}`;
      const req = createMockRequest('POST', cookieStr, {});
      const res = createMockResponse();
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should reject POST when header is present but cookie is missing', () => {
      const token = 'a'.repeat(64);
      const req = createMockRequest('POST', undefined, {
        [CSRF_HEADER_NAME]: token,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should reject POST when tokens do not match', () => {
      const cookieToken = 'a'.repeat(64);
      const headerToken = 'b'.repeat(64);
      const cookieStr = `${CSRF_COOKIE_NAME}=${cookieToken}`;
      const req = createMockRequest('POST', cookieStr, {
        [CSRF_HEADER_NAME]: headerToken,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'CSRF token mismatch' }),
      );
    });

    it('should allow POST when tokens match', () => {
      const token = 'a'.repeat(64);
      const cookieStr = `${CSRF_COOKIE_NAME}=${token}`;
      const req = createMockRequest('POST', cookieStr, {
        [CSRF_HEADER_NAME]: token,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should allow PUT when tokens match', () => {
      const token = 'a'.repeat(64);
      const cookieStr = `${CSRF_COOKIE_NAME}=${token}`;
      const req = createMockRequest('PUT', cookieStr, {
        [CSRF_HEADER_NAME]: token,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should allow PATCH when tokens match', () => {
      const token = 'a'.repeat(64);
      const cookieStr = `${CSRF_COOKIE_NAME}=${token}`;
      const req = createMockRequest('PATCH', cookieStr, {
        [CSRF_HEADER_NAME]: token,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should allow DELETE when tokens match', () => {
      const token = 'a'.repeat(64);
      const cookieStr = `${CSRF_COOKIE_NAME}=${token}`;
      const req = createMockRequest('DELETE', cookieStr, {
        [CSRF_HEADER_NAME]: token,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should reject POST when token length differs (short header token)', () => {
      const cookieToken = 'a'.repeat(64);
      const shortToken = 'bb';
      const cookieStr = `${CSRF_COOKIE_NAME}=${cookieToken}`;
      const req = createMockRequest('POST', cookieStr, {
        [CSRF_HEADER_NAME]: shortToken,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
