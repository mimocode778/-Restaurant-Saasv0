import {
  BadRequestException,
  Body,
  ForbiddenException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import { parse, UUID } from '../common/validation.js';
import type { SessionUser } from './auth.repository.js';
import { bearerToken, Client, CurrentToken, CurrentUser, Public, Roles, sameSiteRequest } from './auth.guard.js';
import { AuthService, type ClientInfo, type LoginResult } from './auth.service.js';
import { clearedSessionCookie, sessionCookie } from './cookies.js';
import { MAX_PASSWORD } from './password-policy.js';

const Code = z.string().regex(/^\d{6}$/, 'The code has 6 digits');

const PasswordLogin = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(1).max(MAX_PASSWORD),
  twoStepCode: Code.optional(),
  recoveryCode: z.string().min(12).max(20).optional(),
  // true for the web app: the token goes into a protected cookie instead of the answer.
  useCookie: z.boolean().optional(),
});

const PinLogin = z.strictObject({
  userId: z.uuid(),
  pin: z.string().regex(/^\d{4,6}$/, 'A PIN is 4 to 6 digits'),
  useCookie: z.boolean().optional(),
});

const PairDevice = z.strictObject({ name: z.string().trim().min(1).max(60) });
const ChangePassword = z.strictObject({
  currentPassword: z.string().min(1).max(MAX_PASSWORD),
  newPassword: z.string().min(1).max(MAX_PASSWORD),
});
const CurrentPassword = z.strictObject({ currentPassword: z.string().min(1).max(MAX_PASSWORD) });
const ConfirmCode = z.strictObject({ code: Code });
const DisableTwoStep = z.strictObject({ currentPassword: z.string().min(1).max(MAX_PASSWORD), code: Code });
const Limit = z.coerce.number().int().min(1).max(500);

// A cookie login must start from our own website, so another site cannot silently log a
// visitor into an account of its choosing.
function checkCookieOrigin(useCookie: boolean | undefined, headers: Record<string, unknown>) {
  if (useCookie && !sameSiteRequest(headers)) {
    throw new ForbiddenException('Request refused: it does not come from the restaurant app');
  }
}

interface CookieResponse {
  setHeader(name: string, value: string): void;
}

function deviceToken(header: unknown): string {
  const token = bearerToken(typeof header === 'string' ? `Bearer ${header}` : undefined);
  if (!token) throw new UnauthorizedException('This tablet is not paired with a restaurant');
  return token;
}

// With useCookie, the token is never visible to the page's JavaScript.
function deliver(result: LoginResult, useCookie: boolean | undefined, res: CookieResponse) {
  if (!useCookie) return result;
  res.setHeader('Set-Cookie', sessionCookie(result.token, result.expiresAt));
  const { token: _token, ...rest } = result;
  return rest;
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  // Owners and managers: email + password (+ 6-digit code if two-step login is on).
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Headers() headers: Record<string, unknown>,
    @Client() info: ClientInfo,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    const input = parse(PasswordLogin, body);
    checkCookieOrigin(input.useCookie, headers);
    if (input.twoStepCode && input.recoveryCode) throw new BadRequestException('Give a code or a recovery code, not both');
    return deliver(await this.auth.loginWithPassword(input, info), input.useCookie, res);
  }

  // Waiters on a paired tablet: pick your name, type your PIN.
  @Public()
  @Get('device/staff')
  deviceStaff(@Headers('x-device-token') header: unknown) {
    return this.auth.deviceStaff(deviceToken(header));
  }

  @Public()
  @Post('pin-login')
  @HttpCode(200)
  async pinLogin(
    @Headers() headers: Record<string, unknown>,
    @Body() body: unknown,
    @Client() info: ClientInfo,
    @Res({ passthrough: true }) res: CookieResponse,
  ) {
    const token = deviceToken(headers['x-device-token']);
    const input = parse(PinLogin, body);
    checkCookieOrigin(input.useCookie, headers);
    return deliver(await this.auth.loginWithPin(token, input.userId, input.pin, info), input.useCookie, res);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentToken() token: string, @Client() info: ClientInfo, @Res({ passthrough: true }) res: CookieResponse) {
    await this.auth.logout(token, info);
    res.setHeader('Set-Cookie', clearedSessionCookie());
  }

  // Ends every session of this person, on every device (for example after a lost phone).
  @Post('logout-everywhere')
  @HttpCode(200)
  async logoutEverywhere(@CurrentUser() user: SessionUser, @Client() info: ClientInfo, @Res({ passthrough: true }) res: CookieResponse) {
    const result = await this.auth.logoutEverywhere(user, info);
    res.setHeader('Set-Cookie', clearedSessionCookie());
    return result;
  }

  @Get('me')
  me(@CurrentUser() user: SessionUser) {
    return user;
  }

  @Post('password')
  @HttpCode(204)
  async changePassword(@CurrentUser() user: SessionUser, @CurrentToken() token: string, @Body() body: unknown, @Client() info: ClientInfo) {
    const input = parse(ChangePassword, body);
    await this.auth.changePassword(user, token, input.currentPassword, input.newPassword, info);
  }

  // Two-step login: 1) setup gives a secret to add to the phone app, 2) confirm with a first code.
  @Roles('owner', 'manager')
  @Post('two-step/setup')
  @HttpCode(200)
  twoStepSetup(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.auth.twoStepSetup(user, parse(CurrentPassword, body).currentPassword);
  }

  @Roles('owner', 'manager')
  @Post('two-step/confirm')
  @HttpCode(200)
  twoStepConfirm(@CurrentUser() user: SessionUser, @Body() body: unknown, @Client() info: ClientInfo) {
    return this.auth.twoStepConfirm(user, parse(ConfirmCode, body).code, info);
  }

  @Roles('owner', 'manager')
  @Post('two-step/disable')
  @HttpCode(204)
  async twoStepDisable(@CurrentUser() user: SessionUser, @Body() body: unknown, @Client() info: ClientInfo) {
    const input = parse(DisableTwoStep, body);
    await this.auth.twoStepDisable(user, input.currentPassword, input.code, info);
  }

  // Tablets: a manager pairs a tablet once; the tablet keeps the returned token.
  @Roles('owner', 'manager')
  @Post('devices')
  pair(@CurrentUser() user: SessionUser, @Body() body: unknown, @Client() info: ClientInfo) {
    return this.auth.pairDevice(user, parse(PairDevice, body).name, info);
  }

  @Roles('owner', 'manager')
  @Get('devices')
  devices(@CurrentUser() user: SessionUser) {
    return this.auth.listDevices(user);
  }

  @Roles('owner', 'manager')
  @Post('devices/:id/revoke')
  @HttpCode(204)
  async revoke(@CurrentUser() user: SessionUser, @Param('id') id: string, @Client() info: ClientInfo) {
    if (!UUID.test(id)) throw new BadRequestException('Invalid tablet id');
    if (!(await this.auth.revokeDevice(user, id, info))) throw new NotFoundException('No such active tablet');
  }

  // Login history of the restaurant, newest first.
  @Roles('owner', 'manager')
  @Get('events')
  events(@CurrentUser() user: SessionUser, @Query('limit') limit?: unknown) {
    return this.auth.events(user, limit === undefined ? 100 : parse(Limit, limit));
  }
}
