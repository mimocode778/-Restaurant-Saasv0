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
import { CurrentUser, Roles } from '../auth/auth.guard.js';
import { parse, UUID } from '../common/validation.js';
import { StaffService } from './staff.service.js';

export const MIN_PASSWORD = 10;

export const NewStaff = z
  .strictObject({
    fullName: z.string().trim().min(1).max(100),
    role: z.enum(['manager', 'waiter']),
    email: z.email().max(254).optional(),
    password: z.string().min(MIN_PASSWORD, `A password needs at least ${MIN_PASSWORD} characters`).max(200).optional(),
    pin: z.string().regex(/^\d{4,6}$/, 'A PIN is 4 to 6 digits').optional(),
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
  async create(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const input = parse(NewStaff, body);
    if (!canManage(user.role, input.role)) {
      throw new ForbiddenException(`A ${user.role} cannot add a ${input.role}`);
    }
    try {
      return await this.staff.create(user.restaurantId, input);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ConflictException('This email is already used');
      throw err;
    }
  }

  @Roles('owner', 'manager')
  @Post(':id/disable')
  @HttpCode(204)
  async disable(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    if (!UUID.test(id)) throw new BadRequestException('Invalid staff id');
    if (id.toLowerCase() === user.userId.toLowerCase()) throw new ForbiddenException('You cannot disable yourself');
    const target = await this.staff.roleOf(user.restaurantId, id);
    if (!target) throw new NotFoundException('No such staff member');
    if (!canManage(user.role, target)) throw new ForbiddenException(`A ${user.role} cannot disable a ${target}`);
    await this.staff.disable(user.restaurantId, id);
  }
}
