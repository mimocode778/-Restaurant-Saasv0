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
import type { SessionUser } from '../auth/auth.repository.js';
import { CurrentUser, Roles } from '../auth/auth.guard.js';
import { parse, UUID } from '../common/validation.js';
import { MenuError } from './menu.repository.js';
import { MenuService } from './menu.service.js';

// A price above 1,000,000 TND is certainly a typing mistake.
const MAX_MILLIMES = 1_000_000_000;

const Name = z.string().trim().min(1);
const Position = z.number().int().min(0).max(10_000);
const PriceTtc = z.number().int('A price is a whole number of millimes (12,500 TND = 12500)').min(0).max(MAX_MILLIMES);
// VAT rate in basis points: 19 % = 1900, 7 % = 700.
const VatRate = z.number().int('A rate is in basis points: 19 % = 1900').min(0).max(10_000);

const NewCategory = z.strictObject({ name: Name.max(60), position: Position.optional() });
const CategoryChanges = z
  .strictObject({ name: Name.max(60).optional(), position: Position.optional() })
  .refine((c) => Object.keys(c).length > 0, 'Nothing to change');

const NewItem = z.strictObject({
  categoryId: z.uuid(),
  name: Name.max(100),
  description: z.string().trim().max(500).optional(),
  position: Position.optional(),
  priceTtcMillimes: PriceTtc,
  vatRateBp: VatRate,
});
// The price is not changed here, on purpose: it has its own route, which keeps a history.
const ItemChanges = z
  .strictObject({
    categoryId: z.uuid().optional(),
    name: Name.max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    position: Position.optional(),
  })
  .refine((c) => Object.keys(c).length > 0, 'Nothing to change');
const NewPrice = z.strictObject({ priceTtcMillimes: PriceTtc, vatRateBp: VatRate });

function id(value: string): string {
  if (!UUID.test(value)) throw new BadRequestException('Invalid id');
  return value;
}

// Turns menu errors into the right answer: 404, 409 or 400.
async function answer<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof MenuError) {
      if (err.kind === 'not_found') throw new NotFoundException(err.message);
      if (err.kind === 'conflict') throw new ConflictException(err.message);
      throw new BadRequestException(err.message);
    }
    throw err;
  }
}

@Controller('menu')
export class MenuController {
  constructor(@Inject(MenuService) private readonly menu: MenuService) {}

  // Everyone on the team can read the menu. Archived dishes only for owners and managers.
  @Get()
  list(@CurrentUser() user: SessionUser, @Query('archived') archived?: string) {
    const includeArchived = archived === 'true' && user.role !== 'waiter';
    return this.menu.list(user, includeArchived);
  }

  @Roles('owner', 'manager')
  @Post('categories')
  async createCategory(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const input = parse(NewCategory, body);
    return { id: await answer(this.menu.createCategory(user, input.name, input.position ?? 0)) };
  }

  @Roles('owner', 'manager')
  @Patch('categories/:id')
  @HttpCode(204)
  async updateCategory(@CurrentUser() user: SessionUser, @Param('id') categoryId: string, @Body() body: unknown) {
    await answer(this.menu.updateCategory(user, id(categoryId), parse(CategoryChanges, body)));
  }

  @Roles('owner', 'manager')
  @Post('categories/:id/archive')
  @HttpCode(204)
  async archiveCategory(@CurrentUser() user: SessionUser, @Param('id') categoryId: string) {
    await answer(this.menu.archiveCategory(user, id(categoryId)));
  }

  @Roles('owner', 'manager')
  @Post('items')
  async createItem(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const input = parse(NewItem, body);
    return { id: await answer(this.menu.createItem(user, { ...input, position: input.position ?? 0 })) };
  }

  @Roles('owner', 'manager')
  @Patch('items/:id')
  @HttpCode(204)
  async updateItem(@CurrentUser() user: SessionUser, @Param('id') itemId: string, @Body() body: unknown) {
    await answer(this.menu.updateItem(user, id(itemId), parse(ItemChanges, body)));
  }

  @Roles('owner', 'manager')
  @Post('items/:id/price')
  @HttpCode(200)
  setPrice(@CurrentUser() user: SessionUser, @Param('id') itemId: string, @Body() body: unknown) {
    const input = parse(NewPrice, body);
    return answer(this.menu.setPrice(user, id(itemId), input.priceTtcMillimes, input.vatRateBp));
  }

  @Roles('owner', 'manager')
  @Get('items/:id/prices')
  priceHistory(@CurrentUser() user: SessionUser, @Param('id') itemId: string) {
    return answer(this.menu.priceHistory(user, id(itemId)));
  }

  @Roles('owner', 'manager')
  @Post('items/:id/archive')
  @HttpCode(204)
  async archive(@CurrentUser() user: SessionUser, @Param('id') itemId: string) {
    await answer(this.menu.setArchived(user, id(itemId), true));
  }

  @Roles('owner', 'manager')
  @Post('items/:id/restore')
  @HttpCode(204)
  async restore(@CurrentUser() user: SessionUser, @Param('id') itemId: string) {
    await answer(this.menu.setArchived(user, id(itemId), false));
  }
}
