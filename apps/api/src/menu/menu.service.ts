import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { SessionUser } from '../auth/auth.repository.js';
import { DbService } from '../db/db.service.js';
import * as repo from './menu.repository.js';

// Thin layer: each action runs as one transaction for the logged-in user's restaurant.
@Injectable()
export class MenuService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  private run<T>(user: SessionUser, work: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.db.withRestaurant(user.restaurantId, work);
  }

  list(user: SessionUser, includeArchived: boolean) {
    return this.run(user, (c) => repo.listMenu(c, includeArchived));
  }

  createCategory(user: SessionUser, name: string, position: number) {
    return this.run(user, (c) => repo.createCategory(c, name, position));
  }

  updateCategory(user: SessionUser, id: string, changes: { name?: string; position?: number }) {
    return this.run(user, (c) => repo.updateCategory(c, id, changes));
  }

  archiveCategory(user: SessionUser, id: string) {
    return this.run(user, (c) => repo.archiveCategory(c, id));
  }

  createItem(user: SessionUser, item: Omit<repo.NewItem, 'changedBy'>) {
    return this.run(user, (c) => repo.createItem(c, { ...item, changedBy: user.userId }));
  }

  updateItem(user: SessionUser, id: string, changes: Parameters<typeof repo.updateItem>[2]) {
    return this.run(user, (c) => repo.updateItem(c, id, changes));
  }

  setPrice(user: SessionUser, id: string, priceTtcMillimes: number, vatRateBp: number) {
    return this.run(user, (c) => repo.setPrice(c, id, priceTtcMillimes, vatRateBp, user.userId));
  }

  setArchived(user: SessionUser, id: string, archived: boolean) {
    return this.run(user, (c) => repo.setArchived(c, id, archived));
  }

  priceHistory(user: SessionUser, id: string) {
    return this.run(user, (c) => repo.priceHistory(c, id));
  }
}
