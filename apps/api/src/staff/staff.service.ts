import { Inject, Injectable } from '@nestjs/common';
import * as auth from '../auth/auth.repository.js';
import type { Role, SessionUser } from '../auth/auth.repository.js';
import type { ClientInfo } from '../auth/auth.service.js';
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

  async create(actor: SessionUser, input: NewStaff, info: ClientInfo): Promise<StaffMember> {
    // Hash before opening the transaction: hashing is slow on purpose.
    const passwordHash = input.password ? await hashSecret(input.password) : undefined;
    const pinHash = input.pin ? await hashSecret(input.pin) : undefined;

    return this.db.withRestaurant(actor.restaurantId, async (c) => {
      const { rows } = await c.query(
        `insert into users (restaurant_id, full_name, role) values (current_restaurant(), $1, $2) returning id`,
        [input.fullName, input.role],
      );
      const id = rows[0].id as string;
      if (input.email && passwordHash) await auth.setPassword(c, id, input.email, passwordHash);
      if (pinHash) await auth.setPin(c, id, pinHash);
      await auth.logEvent(c, { kind: 'staff_created', userId: actor.userId, detail: `${input.role} ${id}`, ...info });
      return { id, fullName: input.fullName, role: input.role, disabled: false };
    });
  }

  roleOf(restaurantId: string, userId: string): Promise<Role | null> {
    return this.db.withRestaurant(restaurantId, async (c) => {
      const { rows } = await c.query('select role from users where id = $1', [userId]);
      return (rows[0]?.role as Role | undefined) ?? null;
    });
  }

  disable(actor: SessionUser, userId: string, info: ClientInfo): Promise<void> {
    return this.db.withRestaurant(actor.restaurantId, async (c) => {
      await c.query('update users set disabled_at = now() where id = $1 and disabled_at is null', [userId]);
      await auth.revokeUserSessions(c, userId, null);
      await auth.logEvent(c, { kind: 'staff_disabled', userId: actor.userId, detail: userId, ...info });
    });
  }

  async resetPassword(actor: SessionUser, userId: string, password: string, info: ClientInfo): Promise<void> {
    const hash = await hashSecret(password);
    await this.db.withRestaurant(actor.restaurantId, async (c) => {
      await auth.replacePassword(c, userId, hash);
      await auth.revokeUserSessions(c, userId, null);
      await auth.logEvent(c, { kind: 'password_reset_by_manager', userId: actor.userId, detail: userId, ...info });
    });
  }

  async resetPin(actor: SessionUser, userId: string, pin: string, info: ClientInfo): Promise<void> {
    const hash = await hashSecret(pin);
    await this.db.withRestaurant(actor.restaurantId, async (c) => {
      await auth.setPin(c, userId, hash);
      await auth.revokeUserSessions(c, userId, null);
      await auth.logEvent(c, { kind: 'pin_reset_by_manager', userId: actor.userId, detail: userId, ...info });
    });
  }

  async resetTwoStep(actor: SessionUser, userId: string, info: ClientInfo): Promise<void> {
    await this.db.withRestaurant(actor.restaurantId, async (c) => {
      await auth.totpDisable(c, userId);
      await auth.revokeUserSessions(c, userId, null);
      await auth.logEvent(c, { kind: 'two_step_disabled', userId: actor.userId, detail: `reset for ${userId}`, ...info });
    });
  }
}
