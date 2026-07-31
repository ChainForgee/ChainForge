import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { TokenService } from '../../auth-oidc/token.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokenService: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearerToken(request);
    const verified = await this.tokenService.verifyAccessToken(token);

    request.user = {
      role: verified.principal.role,
      ngoId: verified.principal.ngoId,
      apiKeyId: verified.principal.apiKeyId,
      authType: 'jwt',
    };

    return true;
  }

  private extractBearerToken(request: Request): string {
    const header = request.headers.authorization;
    if (!header) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid bearer token');
    }

    return token;
  }
}
