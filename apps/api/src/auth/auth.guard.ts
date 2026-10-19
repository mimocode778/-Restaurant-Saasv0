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
import { allowedOrigins } from '../config.js';
import type { Role, SessionUser } from './auth.repository.js';
import { AuthService, type ClientInfo } from './auth.service.js';
import { readCookie, sessionCookieName } from './cookies.js';

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

// Gives the route the token of the current session (for logout, password change).
export const CurrentToken = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const token = ctx.switchToHttp().getRequest().authToken as string | undefined;
  if (!token) throw new UnauthorizedException();
  return token;
});

// The visitor's network address and browser, for attempt limits and the login history.
export const Client = createParamDecorator((_: unknown, ctx: ExecutionContext): ClientInfo => clientInfo(ctx.switchToHttp().getRequest()));

export function clientInfo(req: { ip?: string; headers?: Record<string, unknown> }): ClientInfo {
  const ua = req.headers?.['user-agent'];
  return { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : null };
}

const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

export function bearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer (\S+)$/.exec(header);
  return match && TOKEN.test(match[1]) ? match[1] : null;
}

export function cookieToken(header: unknown): string | null {
  const t = readCookie(header, sessionCookieName());
  return t && TOKEN.test(t) ? t : null;
}

export function hasRole(user: SessionUser, allowed: Role[] | undefined): boolean {
  return !allowed || allowed.length === 0 || allowed.includes(user.role);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// A cookie is sent by the browser automatically, even when another website triggers the
// request. So for a cookie login, any request that changes something must come from one of
// our own websites (protection against "cross-site request forgery").
export function sameSiteRequest(headers: Record<string, unknown> | undefined): boolean {
  const origin = headers?.origin;
  let from = typeof origin === 'string' ? origin : null;
  if (!from && typeof headers?.referer === 'string') {
    try {
      from = new URL(headers.referer).origin;
    } catch {
      from = null;
    }
  }
  return from !== null && allowedOrigins().includes(from);
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
    const fromHeader = bearerToken(req.headers?.authorization);
    const fromCookie = fromHeader ? null : cookieToken(req.headers?.cookie);
    const token = fromHeader ?? fromCookie;
    if (!token) throw new UnauthorizedException('Please log in');

    if (fromCookie && !SAFE_METHODS.has(req.method) && !sameSiteRequest(req.headers)) {
      throw new ForbiddenException('Request refused: it does not come from the restaurant app');
    }

    const user = await this.auth.resolve(token);
    if (!user) throw new UnauthorizedException('Your session has ended, please log in again');

    if (!hasRole(user, this.reflector.getAllAndOverride<Role[]>(ROLES, targets))) {
      throw new ForbiddenException('Your role does not allow this');
    }
    req.user = user;
    req.authToken = token;
    return true;
  }
}
