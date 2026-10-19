import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Passwords that appear in this project's code. Fine on a developer's PC, never on a server.
const DEV_PASSWORDS = new Set(['app', 'app_runtime', 'postgres', 'password', '']);

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (process.env.NODE_ENV === 'production') {
    if (!url) throw new Error('DATABASE_URL must be set in production');
    let password = '';
    try {
      password = decodeURIComponent(new URL(url).password);
    } catch {
      throw new Error('DATABASE_URL is not a valid address');
    }
    if (DEV_PASSWORDS.has(password) || password.length < 16) {
      throw new Error('DATABASE_URL uses a development or short password: set a long random one in production');
    }
    if (process.env.DB_SSL !== 'true') {
      throw new Error('DB_SSL=true is required in production, so database traffic is encrypted');
    }
    return url;
  }
  if (url) return url;
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
    return this.transaction(restaurantId.toLowerCase(), work);
  }

  // Runs `work` as one transaction with NO restaurant selected: row-level security hides
  // every tenant row. Only used for login, where the restaurant is not known yet; the
  // login functions in the database are the only way to reach the data needed.
  async withoutRestaurant<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(null, work);
  }

  private async transaction<T>(restaurantId: string | null, work: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureSafeRole();

    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('begin');
      // `true` = only valid until the end of this transaction, so it can't leak to the next request.
      await client.query(`select set_config('app.restaurant_id', $1, true)`, [restaurantId ?? '']);
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
