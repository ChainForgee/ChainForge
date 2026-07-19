import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ROLES_KEY } from '../../auth/roles.decorator';
import { NO_AUTH_STRICT_KEY } from '../decorators/no-auth-strict.decorator';

@Injectable()
export class UnexpectedAuthHeaderGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers['authorization'];

    // If there is no authorization header, there's no unexpected credential to reject.
    if (!authHeader) {
      return true;
    }

    // Check if the route has roles required (is decorated with @Roles)
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (requiredRoles) {
      return true;
    }

    // Check if the route is explicitly designed for public anonymous access (is decorated with @NoAuthStrict)
    const isNoAuthStrict = this.reflector.getAllAndOverride<boolean>(
      NO_AUTH_STRICT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isNoAuthStrict) {
      return true;
    }

    // Check if the route is in the PUBLIC_AUTH_BYPASS list
    const bypassEnv =
      this.configService.get<string>('PUBLIC_AUTH_BYPASS') ?? '';
    const bypassedPaths = bypassEnv
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);

    const requestPath = request.path;
    const isBypassed = bypassedPaths.some(bpath => {
      const cleanBPath = bpath.replace(/^\/+|\/+$/g, '');
      const cleanReqPath = requestPath.replace(/^\/+|\/+$/g, '');
      if (cleanBPath === cleanReqPath) return true;
      if (cleanReqPath.endsWith(cleanBPath)) {
        const index = cleanReqPath.lastIndexOf(cleanBPath);
        if (index > 0 && cleanReqPath.charAt(index - 1) === '/') return true;
      }
      return false;
    });

    if (isBypassed) {
      return true;
    }

    // Undecorated route received an unexpected authorization header
    throw new UnauthorizedException(
      'Unexpected authorization credentials on undecorated route',
    );
  }
}
