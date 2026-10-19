import { Inject, Injectable } from '@nestjs/common';
import * as auth from '../auth/auth.repository.js';
import type { Role } from '../auth/auth.repository.js';
import { hashSecret } from '../auth/secrets.js';
import { DbService } from '../db/db.service.js';
import type { NewStaff } from './staff.controller.js';

export interface StaffMember {
  id: string;
  fullName: string;
  role: Role;
  disabled: boolean;
}

@Injectable()
export class StaffService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  // Row-level security limits every query here to the caller's restaurant.
  list(restaurantId: string): Promise<StaffMember[]> {
    return this.db.withRestaurant(restaurantId, async (c) => {
      const { rows } = await c.query(
        `select id, full_name, role, disabled_at is not null as disabled from users order by full_name`,
      );
      return rows.map((r) => ({ id: r.id, fullName: r.full_name, role: r.role, disabled: r.disabled }));
    });
  }

  async create(restaurantId: string, input: NewStaff): Promise<StaffMember> {
    // Hash before opening the transaction: hashing is slow on purpose.
    const passwordHash = input.password ? await hashSecret(input.password) : undefined;
    const pinHash = input.pin ? await hashSecret(input.pin) : undefined;

    return this.db.withRestaurant(restaurantId, async (c) => {
      const { rows } = await c.query(
        `insert into users (restaurant_id, full_name, role) values (current_restaurant(), $1, $2) returning id`,
        [input.fullName, input.role],
      );
      const id = rows[0].id as string;
      if (input.email && passwordHash) await auth.setPassword(c, id, input.email, passwordHash);
      if (pinHash) await auth.setPin(c, id, pinHash);
      return { id, fullName: input.fullName, role: input.role, disabled: false };
    });
  }

  roleOf(restaurantId: string, userId: string): Promise<Role | null> {
    return this.db.withRestaurant(restaurantId, async (c) => {
      const { rows } = await c.query('select role from users where id = $1', [userId]);
      return (rows[0]?.role as Role | undefined) ?? null;
    });
  }

  // Their open sessions stop working at once: sessions are checked against disabled_at.
  disable(restaurantId: string, userId: string): Promise<void> {
    return this.db.withRestaurant(restaurantId, async (c) => {
      await c.query('update users set disabled_at = now() where id = $1 and disabled_at is null', [userId]);
    });
  }
}
