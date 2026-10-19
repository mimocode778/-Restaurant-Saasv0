import { Body, Controller, ForbiddenException, Get, Inject, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { SessionUser } from '../auth/auth.repository.js';
import { CurrentUser } from '../auth/auth.guard.js';
import { parse } from '../common/validation.js';
import { SalesService } from './sales.service.js';

// A single event above 1,000,000 TND is almost certainly a typing mistake.
const MAX_MILLIMES = 1_000_000_000;

// strictObject: unknown fields (like "source" or "restaurantId") are rejected, not ignored.
const CreateSale = z
  .strictObject({
    occurredAt: z.string().datetime({ offset: true }),
    kind: z.enum(['sale', 'void', 'discount', 'refund']),
    amountMillimes: z.number().int().min(-MAX_MILLIMES).max(MAX_MILLIMES),
    externalRef: z.string().min(1).max(100).optional(),
  })
  .refine((s) => (s.kind === 'sale' ? s.amountMillimes >= 0 : s.amountMillimes <= 0), {
    message: 'A sale must not be negative; a void, discount or refund must not be positive',
    path: ['amountMillimes'],
  });

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Day must look like 2026-10-19');

// A void, discount or refund takes money back: only an owner or manager may record one.
function mayRecord(user: SessionUser, kind: string): boolean {
  return kind === 'sale' || user.role === 'owner' || user.role === 'manager';
}

function todayInTunis(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
}

@Controller('sales')
export class SalesController {
  constructor(@Inject(SalesService) private readonly sales: SalesService) {}

  @Post()
  async create(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const input = parse(CreateSale, body);
    if (!mayRecord(user, input.kind)) {
      throw new ForbiddenException('Only an owner or manager can record a void, discount or refund');
    }
    // The restaurant always comes from the login, never from the request.
    return this.sales.record(user.restaurantId, {
      occurredAt: new Date(input.occurredAt),
      kind: input.kind,
      amountMillimes: input.amountMillimes,
      source: 'manual',
      externalRef: input.externalRef,
    });
  }

  @Get('summary')
  async summary(@CurrentUser() user: SessionUser, @Query('day') day?: unknown) {
    const wanted = day === undefined ? todayInTunis() : parse(Day, day);
    return this.sales.summary(user.restaurantId, wanted);
  }
}
