import { AppRole } from '../auth/app-role.enum';

declare global {
  namespace Express {
    interface Request {
      user?: {
        role: AppRole;
        id?: string;
        sub?: string;
        email?: string;
        address?: string;
        orgId?: string;
        ngoId?: string | null;
        apiKeyId?: string;
        authType?: 'apiKey' | 'envApiKey';
      };
    }
  }
}
