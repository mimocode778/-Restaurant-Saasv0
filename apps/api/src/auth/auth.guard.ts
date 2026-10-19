import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role, SessionUser } from './auth.repository.js';
import { AuthService } from './auth.service.js';

// Every route needs a logged-in user, unless it is marked @Public().
const PUBLIC = 'auth:public';
const ROLES = 'auth:roles';

export const Public = () => SetMetadata(PUBLIC, true);

// Only these roles may call the route. Without @Roles, any logged-in user may.
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

// Gives the route the logged-in user (and so their restaurant).
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionUser => {
  const user = ctx.switchToHttp().getRequest().user as SessionUser | undefined;
  if (!user) throw new UnauthorizedException();
  return user;
});

export function bearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
  return match ? match[1] : null;
}

export function hasRole(user: SessionUser, allowed: Role[] | undefined): boolean {
  return !allowed || allowed.length === 0 || allowed.includes(user.role);
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const token = bearerToken(req.headers?.authorization);
    if (!token) throw new UnauthorizedException('Please log in');

    const user = await this.auth.resolve(token);
    if (!user) throw new UnauthorizedException('Your session has ended, please log in again');

    if (!hasRole(user, this.reflector.getAllAndOverride<Role[]>(ROLES, targets))) {
      throw new ForbiddenException('Your role does not allow this');
    }
    req.user = user;
    return true;
  }
}
