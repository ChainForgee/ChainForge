import { UnauthorizedException } from '@nestjs/common';
import { AppRole } from '../../auth/app-role.enum';
import { ApiKeyGuard } from './api-key.guard';

const mockReflector = { getAllAndOverride: jest.fn().mockReturnValue(false) };
const mockConfigService = { get: jest.fn().mockReturnValue('test-api-key') };
const mockPrismaService = {
  apiKey: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
};

const createContext = (headers: Record<string, string>) => {
  const req: Record<string, unknown> = { headers };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  };
};

describe('ApiKeyGuard JWT regression', () => {
  let guard: ApiKeyGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReflector.getAllAndOverride.mockReturnValue(false);
    mockConfigService.get.mockReturnValue('test-api-key');
    mockPrismaService.apiKey.findFirst.mockResolvedValue(null);
    mockPrismaService.apiKey.update.mockResolvedValue({});

    guard = new ApiKeyGuard(
      mockConfigService as any,
      mockReflector as any,
      mockPrismaService as any,
    );
  });

  it('still ignores bearer JWTs and requires x-api-key unless a route is public', async () => {
    const context = createContext({ authorization: 'Bearer jwt-token' });

    await expect(guard.canActivate(context as any)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('still attaches the same API-key principal shape for database API keys', async () => {
    mockPrismaService.apiKey.findFirst.mockResolvedValue({
      id: 'api-key-1',
      role: AppRole.admin,
      ngoId: null,
    });

    const context = createContext({ 'x-api-key': 'test-api-key' });
    await expect(guard.canActivate(context as any)).resolves.toBe(true);

    expect(context.switchToHttp().getRequest().user).toMatchObject({
      role: AppRole.admin,
      apiKeyId: 'api-key-1',
      authType: 'apiKey',
    });
  });
});
