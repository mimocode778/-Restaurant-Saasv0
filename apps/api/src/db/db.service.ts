import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url) return url;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL must be set in production');
  }
  // Development only. Never used in production.
  return 'postgresql://app_runtime:app_runtime@localhost:15432/restaurant';
}

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private roleVerified = false;

  private readonly pool = new Pool({
    connectionString: databaseUrl(),
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 15_000,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  });

  constructor() {
    this.pool.on('error', (err) => this.logger.error(`Idle database client error: ${err.message}`));
  }

  // Fail closed: a role that bypasses row-level security would defeat tenant isolation.
  private async ensureSafeRole(): Promise<void> {
    if (this.roleVerified) return;
    const { rows } = await this.pool.query(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    if (rows[0]?.rolsuper || rows[0]?.rolbypassrls) {
      throw new Error('Unsafe database role: it bypasses row-level security');
    }
    this.roleVerified = true;
  }

  // Runs `work` as one transaction scoped to a single restaurant.
  async withRestaurant<T>(restaurantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!UUID.test(restaurantId)) {
      throw new Error('Invalid restaurant id');
    }
    await this.ensureSafeRole();

    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('begin');
      // `true` = only valid until the end of this transaction, so it can't leak to the next request.
      await client.query(`select set_config('app.restaurant_id', $1, true)`, [restaurantId.toLowerCase()]);
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (err) {
      try {
        await client.query('rollback');
      } catch (rollbackErr) {
        broken = rollbackErr as Error;
      }
      throw err;
    } finally {
      // Passing an error destroys the connection instead of returning it to the pool.
      client.release(broken);
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
