import { BadRequestException, Body, Controller, Get, Headers, Inject, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { SalesService } from './sales.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({
      message: 'Invalid request',
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

// TEMPORARY: the restaurant comes from a header the client controls. This is NOT secure.
// It will be replaced by the restaurant of the logged-in user.
function restaurantFrom(header: unknown): string {
  if (typeof header !== 'string' || !UUID.test(header)) {
    throw new BadRequestException('Missing or invalid x-restaurant-id header');
  }
  return header;
}

function todayInTunis(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis' }).format(new Date());
}

@Controller('sales')
export class SalesController {
  constructor(@Inject(SalesService) private readonly sales: SalesService) {}

  @Post()
  async create(@Headers('x-restaurant-id') restaurantHeader: unknown, @Body() body: unknown) {
    const restaurantId = restaurantFrom(restaurantHeader);
    const input = parse(CreateSale, body);
    return this.sales.record(restaurantId, {
      occurredAt: new Date(input.occurredAt),
      kind: input.kind,
      amountMillimes: input.amountMillimes,
      source: 'manual',
      externalRef: input.externalRef,
    });
  }

  @Get('summary')
  async summary(@Headers('x-restaurant-id') restaurantHeader: unknown, @Query('day') day?: unknown) {
    const restaurantId = restaurantFrom(restaurantHeader);
    const wanted = day === undefined ? todayInTunis() : parse(Day, day);
    return this.sales.summary(restaurantId, wanted);
  }
}
