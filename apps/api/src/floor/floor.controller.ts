import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { SessionUser } from '../auth/auth.repository.js';
import { CurrentUser, Roles } from '../auth/auth.guard.js';
import { parse, UUID } from '../common/validation.js';
import { DbService } from '../db/db.service.js';
import * as repo from './floor.repository.js';

const Cm = z.number().int().min(0).max(10_000);
const Plan = z.strictObject({ widthCm: z.number().int().min(300).max(10_000), depthCm: z.number().int().min(300).max(10_000) });
const NewItem = z
  .strictObject({
    kind: z.enum(['table', 'counter', 'kitchen', 'plant', 'door']),
    label: z.string().trim().min(1).max(30),
    seats: z.number().int().min(1).max(20).optional(),
    xCm: Cm,
    zCm: Cm,
    rotationDeg: z.number().int().min(0).max(359).optional(),
  })
  .refine((i) => (i.kind === 'table') === (i.seats !== undefined), {
    message: 'A table needs a number of seats; other items have none',
    path: ['seats'],
  });
const Changes = z
  .strictObject({
    label: z.string().trim().min(1).max(30).optional(),
    seats: z.number().int().min(1).max(20).optional(),
    xCm: Cm.optional(),
    zCm: Cm.optional(),
    rotationDeg: z.number().int().min(0).max(359).optional(),
  })
  .refine((c) => Object.keys(c).length > 0, 'Nothing to change');

function id(value: string): string {
  if (!UUID.test(value)) throw new BadRequestException('Invalid id');
  return value;
}

async function answer<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof repo.FloorError) {
      if (err.kind === 'not_found') throw new NotFoundException(err.message);
      if (err.kind === 'conflict') throw new ConflictException(err.message);
      throw new BadRequestException(err.message);
    }
    throw err;
  }
}

@Injectable()
export class FloorService {
  constructor(@Inject(DbService) private readonly db: DbService) {}
  run<T>(user: SessionUser, work: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.db.withRestaurant(user.restaurantId, work);
  }
}

// The dining room: everyone on the team sees it; owners and managers arrange it.
@Controller('floor')
export class FloorController {
  constructor(@Inject(FloorService) private readonly floor: FloorService) {}

  @Get()
  get(@CurrentUser() user: SessionUser) {
    return this.floor.run(user, (c) => repo.getFloor(c));
  }

  @Roles('owner', 'manager')
  @Put('plan')
  @HttpCode(204)
  async setPlan(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const p = parse(Plan, body);
    await answer(this.floor.run(user, (c) => repo.setPlan(c, p.widthCm, p.depthCm)));
  }

  @Roles('owner', 'manager')
  @Post('items')
  async create(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    const i = parse(NewItem, body);
    const newId = await answer(
      this.floor.run(user, (c) => repo.createItem(c, { ...i, seats: i.seats ?? null, rotationDeg: i.rotationDeg ?? 0 })),
    );
    return { id: newId };
  }

  @Roles('owner', 'manager')
  @Patch('items/:id')
  @HttpCode(204)
  async update(@CurrentUser() user: SessionUser, @Param('id') itemId: string, @Body() body: unknown) {
    const changes = parse(Changes, body);
    await answer(this.floor.run(user, (c) => repo.updateItem(c, id(itemId), changes)));
  }

  @Roles('owner', 'manager')
  @Post('items/:id/archive')
  @HttpCode(204)
  async archive(@CurrentUser() user: SessionUser, @Param('id') itemId: string) {
    await answer(this.floor.run(user, (c) => repo.archiveItem(c, id(itemId))));
  }
}
