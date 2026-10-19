// For you, the operator of the service, when an OWNER has forgotten their password
// (or lost the phone used for two-step login). Owners and managers can reset their own
// staff from the app; only the owner needs this.
//
//   pnpm --filter api reset-owner-password --email ali@example.tn
//   pnpm --filter api reset-owner-password --email ali@example.tn --clear-two-step
//
// IMPORTANT: check the person's identity first (call them on the number you know), because
// whoever gets the new password gets the whole restaurant.
// The new password is asked for afterwards, so it does not stay in your terminal history.
// All the person's sessions are ended. Uses the admin database account (DATABASE_URL).
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { MIN_PASSWORD, passwordProblem } from '../dist/auth/password-policy.js';
import { hashSecret } from '../dist/auth/secrets.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, 'clear-two-step': { type: 'boolean' } } });
const email = values.email?.trim().toLowerCase();
if (!email) {
  console.error('Usage: pnpm --filter api reset-owner-password --email owner@example.tn [--clear-two-step]');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question(`New password for ${email} (at least ${MIN_PASSWORD} characters, it will be visible): `);
rl.close();
const problem = passwordProblem(password, email);
if (problem) {
  console.error(`${problem}.`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://app:app@localhost:15432/restaurant' });
await client.connect();
try {
  await client.query('begin');
  const found = await client.query(
    `select c.user_id, c.restaurant_id from credentials c join users u on u.id = c.user_id
     where c.email = $1 and u.role = 'owner'`,
    [email],
  );
  if (found.rowCount === 0) throw new Error('No owner account with this email');
  const { user_id: userId, restaurant_id: restaurantId } = found.rows[0];
  await client.query('update credentials set password_hash = $2, updated_at = now() where user_id = $1', [userId, await hashSecret(password)]);
  await client.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [userId]);
  await client.query(
    `insert into auth_events (restaurant_id, user_id, kind, detail) values ($1, $2, 'password_reset_by_manager', 'reset by the service operator')`,
    [restaurantId, userId],
  );
  if (values['clear-two-step']) {
    await client.query('delete from recovery_codes where user_id = $1', [userId]);
    await client.query('delete from totp_factors where user_id = $1', [userId]);
    await client.query(
      `insert into auth_events (restaurant_id, user_id, kind, detail) values ($1, $2, 'two_step_disabled', 'reset by the service operator')`,
      [restaurantId, userId],
    );
  }
  await client.query('commit');
  console.log(`New password set for ${email}. All their sessions were ended.${values['clear-two-step'] ? ' Two-step login was turned off.' : ''}`);
} catch (err) {
  await client.query('rollback');
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
