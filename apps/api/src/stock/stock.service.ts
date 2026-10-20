import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { SessionUser } from '../auth/auth.repository.js';
import { DbService } from '../db/db.service.js';
import * as repo from './stock.repository.js';

// Thin layer: each action runs as one transaction for the logged-in user's restaurant,
// and the author of every movement is the logged-in user.
@Injectable()
export class StockService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  private run<T>(user: SessionUser, work: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.db.withRestaurant(user.restaurantId, work);
  }

  list(user: SessionUser, includeArchived: boolean) {
    return this.run(user, (c) => repo.listItems(c, includeArchived));
  }

  get(user: SessionUser, id: string) {
    return this.run(user, (c) => repo.getItem(c, id));
  }

  create(user: SessionUser, item: repo.NewItem) {
    return this.run(user, (c) => repo.createItem(c, item));
  }

  update(user: SessionUser, id: string, changes: Parameters<typeof repo.updateItem>[2]) {
    return this.run(user, (c) => repo.updateItem(c, id, changes));
  }

  setArchived(user: SessionUser, id: string, archived: boolean) {
    return this.run(user, (c) => repo.setArchived(c, id, archived));
  }

  addPack(user: SessionUser, itemId: string, name: string, quantityBase: number) {
    return this.run(user, (c) => repo.addPack(c, itemId, name, quantityBase));
  }

  archivePack(user: SessionUser, itemId: string, packId: string) {
    return this.run(user, (c) => repo.archivePack(c, itemId, packId));
  }

  record(user: SessionUser, itemId: string, movement: repo.NewMovement) {
    return this.run(user, (c) => repo.recordMovement(c, itemId, movement, user.userId));
  }

  count(user: SessionUser, lines: repo.CountLine[], note: string | undefined) {
    return this.run(user, (c) => repo.recordCount(c, lines, note, user.userId));
  }

  history(user: SessionUser, itemId: string, limit: number) {
    return this.run(user, (c) => repo.history(c, itemId, limit));
  }

  report(user: SessionUser, from: string, to: string) {
    return this.run(user, (c) => repo.report(c, from, to));
  }
}
