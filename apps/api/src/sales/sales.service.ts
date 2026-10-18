import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { insertSale, salesForDay, type DaySummary, type NewSale } from './sales.repository.js';

@Injectable()
export class SalesService {
  // Explicit @Inject keeps injection working in every build and test setup.
  constructor(@Inject(DbService) private readonly db: DbService) {}

  record(restaurantId: string, sale: NewSale): Promise<{ duplicate: boolean }> {
    return this.db.withRestaurant(restaurantId, (client) => insertSale(client, sale));
  }

  summary(restaurantId: string, day: string): Promise<DaySummary> {
    return this.db.withRestaurant(restaurantId, (client) => salesForDay(client, day));
  }
}
