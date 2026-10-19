import { Body, Controller, Get, Headers, HttpCode, Inject, Post, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/validation.js';
import type { SessionUser } from './auth.repository.js';
import { bearerToken, CurrentUser, Public, Roles } from './auth.guard.js';
import { AuthService } from './auth.service.js';

const PasswordLogin = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});

const PinLogin = z.strictObject({
  userId: z.uuid(),
  pin: z.string().regex(/^\d{4,6}$/, 'A PIN is 4 to 6 digits'),
});

const PairDevice = z.strictObject({
  name: z.string().trim().min(1).max(60),
});

function deviceToken(header: unknown): string {
  const token = bearerToken(typeof header === 'string' ? `Bearer ${header}` : undefined);
  if (!token) throw new UnauthorizedException('This tablet is not paired with a restaurant');
  return token;
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  // Owners and managers: email + password.
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown) {
    const input = parse(PasswordLogin, body);
    return this.auth.loginWithPassword(input.email, input.password);
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
  pinLogin(@Headers('x-device-token') header: unknown, @Body() body: unknown) {
    const token = deviceToken(header);
    const input = parse(PinLogin, body);
    return this.auth.loginWithPin(token, input.userId, input.pin);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Headers('authorization') header: unknown) {
    const token = bearerToken(header);
    if (token) await this.auth.logout(token);
  }

  @Get('me')
  me(@CurrentUser() user: SessionUser) {
    return user;
  }

  // A manager pairs a tablet once; the tablet keeps the returned token.
  @Roles('owner', 'manager')
  @Post('devices')
  pair(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.auth.pairDevice(user, parse(PairDevice, body).name);
  }
}
