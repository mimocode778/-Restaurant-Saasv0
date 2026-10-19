import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import type { Role, SessionUser } from '../auth/auth.repository.js';
import { Client, CurrentUser, Roles } from '../auth/auth.guard.js';
import type { ClientInfo } from '../auth/auth.service.js';
import { MAX_PASSWORD, passwordProblem } from '../auth/password-policy.js';
import { parse, UUID } from '../common/validation.js';
import { StaffService } from './staff.service.js';

const Pin = z.string().regex(/^\d{4,6}$/, 'A PIN is 4 to 6 digits');
const Password = z.string().max(MAX_PASSWORD);

export const NewStaff = z
  .strictObject({
    fullName: z.string().trim().min(1).max(100),
    role: z.enum(['manager', 'waiter']),
    email: z.email().max(254).optional(),
    password: Password.optional(),
    pin: Pin.optional(),
  })
  .superRefine((s, ctx) => {
    const problem = s.password === undefined ? null : passwordProblem(s.password, s.email);
    if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['password'] });
  })
  .refine((s) => (s.email === undefined) === (s.password === undefined), {
    message: 'Give both an email and a password, or neither',
    path: ['password'],
  })
  .refine((s) => s.role !== 'manager' || s.email !== undefined, {
    message: 'A manager needs an email and a password',
    path: ['email'],
  })
  .refine((s) => s.role !== 'waiter' || s.pin !== undefined, {
    message: 'A waiter needs a PIN',
    path: ['pin'],
  })
  .refine((s) => s.role === 'waiter' || s.pin === undefined, {
    message: 'Only waiters log in with a PIN',
    path: ['pin'],
  });
export type NewStaff = z.infer<typeof NewStaff>;

const ResetPassword = z.strictObject({ newPassword: Password });
const ResetPin = z.strictObject({ pin: Pin });

// Who may create or disable whom.
const MANAGES: Record<Role, Role[]> = { owner: ['manager', 'waiter'], manager: ['waiter'], waiter: [] };

export function canManage(actor: Role, target: Role): boolean {
  return MANAGES[actor].includes(target);
}

@Controller('staff')
export class StaffController {
  constructor(@Inject(StaffService) private readonly staff: StaffService) {}

  @Roles('owner', 'manager')
  @Get()
  list(@CurrentUser() user: SessionUser) {
    return this.staff.list(user.restaurantId);
  }

  @Roles('owner', 'manager')
  @Post()
  async create(@CurrentUser() user: SessionUser, @Body() body: unknown, @Client() info: ClientInfo) {
    const input = parse(NewStaff, body);
    if (!canManage(user.role, input.role)) {
      throw new ForbiddenException(`A ${user.role} cannot add a ${input.role}`);
    }
    try {
      return await this.staff.create(user, input, info);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ConflictException('This email is already used');
      throw err;
    }
  }

  // Checks that the target exists in this restaurant and that the caller may manage them.
  private async target(user: SessionUser, id: string): Promise<Role> {
    if (!UUID.test(id)) throw new BadRequestException('Invalid staff id');
    if (id.toLowerCase() === user.userId.toLowerCase()) {
      throw new ForbiddenException('Use your own account settings for yourself');
    }
    const role = await this.staff.roleOf(user.restaurantId, id);
    if (!role) throw new NotFoundException('No such staff member');
    if (!canManage(user.role, role)) throw new ForbiddenException(`A ${user.role} cannot manage a ${role}`);
    return role;
  }

  // Disabling ends all their sessions at once.
  @Roles('owner', 'manager')
  @Post(':id/disable')
  @HttpCode(204)
  async disable(@CurrentUser() user: SessionUser, @Param('id') id: string, @Client() info: ClientInfo) {
    await this.target(user, id);
    await this.staff.disable(user, id, info);
  }

  // For a manager who forgot their password: the owner sets a new one. Ends their sessions.
  @Roles('owner')
  @Post(':id/reset-password')
  @HttpCode(204)
  async resetPassword(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown, @Client() info: ClientInfo) {
    await this.target(user, id);
    const { newPassword } = parse(ResetPassword, body);
    const problem = passwordProblem(newPassword);
    if (problem) throw new BadRequestException(problem);
    await this.staff.resetPassword(user, id, newPassword, info);
  }

  // For a waiter who forgot their PIN. Ends their sessions.
  @Roles('owner', 'manager')
  @Post(':id/reset-pin')
  @HttpCode(204)
  async resetPin(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown, @Client() info: ClientInfo) {
    const role = await this.target(user, id);
    if (role !== 'waiter') throw new BadRequestException('Only waiters have a PIN');
    await this.staff.resetPin(user, id, parse(ResetPin, body).pin, info);
  }

  // For a manager who lost their phone: the owner turns their two-step login off.
  @Roles('owner')
  @Post(':id/reset-two-step')
  @HttpCode(204)
  async resetTwoStep(@CurrentUser() user: SessionUser, @Param('id') id: string, @Client() info: ClientInfo) {
    await this.target(user, id);
    await this.staff.resetTwoStep(user, id, info);
  }
}
