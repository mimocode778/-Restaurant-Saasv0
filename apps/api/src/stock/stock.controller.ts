import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { MAX_QUANTITY_BASE } from '@app/shared';
import type { SessionUser } from '../auth/auth.repository.js';
import { CurrentUser, Roles } from '../auth/auth.guard.js';
import { parse, UUID } from '../common/validation.js';
import { StockError } from './stock.repository.js';
import { StockService } from './stock.service.js';

// A delivery line above 10,000,000 TND is certainly a typing mistake.
const MAX_COST_MILLIMES = 10_000_000_000;

const Name = z.string().trim().min(1);
const Quantity = z
  .number()
  .int('A quantity is a whole number in the base unit: 1.5 kg = 1500 (grams)')
  .min(0)
  .max(MAX_QUANTITY_BASE);
const PositiveQuantity = Quantity.min(1, 'The quantity must be more than zero');
const Place = z.enum(['fridge', 'freezer', 'dry_store', 'bar', 'other']);
const Note = z.string().trim().min(1).max(200).optional();

const NewItem = z.strictObject({
  name: Name.max(100),
  baseUnit: z.enum(['g', 'ml', 'piece']),
  storagePlace: Place.optional(),
  alertLevelBase: Quantity.nullable().optional(),
});
// The unit cannot be changed, on purpose: the product's history is counted in it.
const ItemChanges = z
  .strictObject({
    name: Name.max(100).optional(),
    storagePlace: Place.optional(),
    alertLevelBase: Quantity.nullable().optional(),
  })
  .refine((c) => Object.keys(c).length > 0, 'Nothing to change');

const NewPack = z.strictObject({ name: Name.max(60), quantityBase: PositiveQuantity });

// strictObject: unknown fields (like "occurredAt", "recordedBy" or "restaurantId") are refused.
// There is no time or author field on purpose: the server sets both.
// Quantities are always positive here; the kind decides if stock goes up or down.
const Movement = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('purchase'),
      quantityBase: PositiveQuantity.optional(),
      packId: z.uuid().optional(),
      packCount: z.number().int().min(1).max(10_000).optional(),
      costMillimes: z.number().int('A price is a whole number of millimes (12,500 TND = 12500)').min(0).max(MAX_COST_MILLIMES).optional(),
      note: Note,
    })
    .refine((m) => (m.packId === undefined) !== (m.quantityBase === undefined), {
      message: 'Give either a quantity (quantityBase) or a pack size (packId) with a number of packs',
      path: ['quantityBase'],
    })
    .refine((m) => (m.packId === undefined) === (m.packCount === undefined), {
      message: 'A pack size (packId) needs a number of packs (packCount), and the other way round',
      path: ['packCount'],
    }),
  z.strictObject({ kind: z.literal('usage'), quantityBase: PositiveQuantity, note: Note }),
  z.strictObject({
    kind: z.literal('waste'),
    quantityBase: PositiveQuantity,
    reason: z.enum(['spoiled', 'expired', 'burnt', 'dropped', 'other']),
    note: Note,
  }),
]);

const Count = z.strictObject({
  lines: z
    .array(z.strictObject({ stockItemId: z.uuid(), countedBase: Quantity }))
    .min(1, 'Count at least one product')
    .max(1000),
  note: Note,
});

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Day must look like 2026-10-19');
const Limit = z.coerce.number().int().min(1).max(500);

function id(value: string): string {
  if (!UUID.test(value)) throw new BadRequestException('Invalid id');
  return value;
}

// Turns stock errors into the right answer: 404, 409 or 400.
async function answer<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof StockError) {
      if (err.kind === 'not_found') throw new NotFoundException(err.message);
      if (err.kind === 'conflict') throw new ConflictException(err.message);
      throw new BadRequestException(err.message);
    }
    throw err;
  }
}

// Stock is for owners and managers only (set once for every route below).
@Roles('owner', 'manager')
@Controller('stock')
export class StockController {
  constructor(@Inject(StockService) private readonly stock: StockService) {}

  @Get('items')
  list(@CurrentUser() user: SessionUser, @Query('archived') archived?: string) {
    return this.stock.list(user, archived === 'true');
  }

  @Get('items/:id')
  get(@CurrentUser() user: SessionUser, @Param('id') itemId: string) {
    return answer(this.stock.get(user, id(itemId)));
  }

  @Post('items')
  async create(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const input = parse(NewItem, body);
    const created = await answer(
      this.stock.create(user, {
        name: input.name,
        baseUnit: input.baseUnit,
        storagePlace: input.storagePlace ?? 'other',
        alertLevelBase: input.alertLevelBase ?? null,
      }),
    );
    return { id: created };
  }

  @Patch('items/:id')
  @HttpCode(204)
  async update(@CurrentUser() user: SessionUser, @Param('id') itemId: string, @Body() body: unknown) {
    await answer(this.stock.update(user, id(itemId), parse(ItemChanges, body)));
  }

  @Post('items/:id/archive')
  @HttpCode(204)
  async archive(@CurrentUser() user: SessionUser, @Param('id') itemId: string) {
    await answer(this.stock.setArchived(user, id(itemId), true));
  }

  @Post('items/:id/restore')
  @HttpCode(204)
  async restore(@CurrentUser() user: SessionUser, @Param('id') itemId: string) {
    await answer(this.stock.setArchived(user, id(itemId), false));
  }

  @Post('items/:id/packs')
  async addPack(@CurrentUser() user: SessionUser, @Param('id') itemId: string, @Body() body: unknown) {
    const input = parse(NewPack, body);
    return { id: await answer(this.stock.addPack(user, id(itemId), input.name, input.quantityBase)) };
  }

  @Post('items/:id/packs/:packId/archive')
  @HttpCode(204)
  async archivePack(@CurrentUser() user: SessionUser, @Param('id') itemId: string, @Param('packId') packId: string) {
    await answer(this.stock.archivePack(user, id(itemId), id(packId)));
  }

  // A delivery, a usage or a waste. Answers with the new stock and the warnings.
  @Post('items/:id/movements')
  record(@CurrentUser() user: SessionUser, @Param('id') itemId: string, @Body() body: unknown) {
    return answer(this.stock.record(user, id(itemId), parse(Movement, body)));
  }

  @Get('items/:id/movements')
  history(@CurrentUser() user: SessionUser, @Param('id') itemId: string, @Query('limit') limit?: unknown) {
    const wanted = limit === undefined ? 100 : parse(Limit, limit);
    return answer(this.stock.history(user, id(itemId), wanted));
  }

  // A stocktake: the real quantities counted on the shelves.
  @Post('counts')
  @HttpCode(200)
  count(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const input = parse(Count, body);
    return answer(this.stock.count(user, input.lines, input.note));
  }

  @Get('report')
  report(@CurrentUser() user: SessionUser, @Query('from') from?: unknown, @Query('to') to?: unknown) {
    return answer(this.stock.report(user, parse(Day, from), parse(Day, to)));
  }
}
