// Creates a new restaurant and its owner account (the first login).
//
//   pnpm --filter api create-owner --restaurant "Chez Ali" --name "Ali Ben Salah" --email ali@example.tn
//
// The password is asked for afterwards, so it does not stay in your terminal history.
// Uses the admin database account (DATABASE_URL), not the API's limited account.
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { MIN_PASSWORD, passwordProblem } from '../dist/auth/password-policy.js';
import { hashSecret } from '../dist/auth/secrets.js';
import { adminDatabaseUrl } from './db-url.mjs';

const { values } = parseArgs({
  options: { restaurant: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } },
});
const restaurant = values.restaurant?.trim();
const name = values.name?.trim();
const email = values.email?.trim().toLowerCase();
if (!restaurant || !name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Usage: pnpm --filter api create-owner --restaurant "Name" --name "Owner name" --email owner@example.tn');
  process.exit(1);
}

// Checked before asking anything, so nothing is typed for nothing.
const dbUrl = adminDatabaseUrl();

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question(`Password for ${email} (at least ${MIN_PASSWORD} characters, it will be visible): `);
rl.close();
const problem = passwordProblem(password, email);
if (problem) {
  console.error(`${problem}.`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
try {
  await client.query('begin');
  const r = await client.query('insert into restaurants (name) values ($1) returning id', [restaurant]);
  const u = await client.query(
    `insert into users (restaurant_id, full_name, role) values ($1, $2, 'owner') returning id`,
    [r.rows[0].id, name],
  );
  await client.query(
    'insert into credentials (user_id, restaurant_id, email, password_hash) values ($1, $2, $3, $4)',
    [u.rows[0].id, r.rows[0].id, email, await hashSecret(password)],
  );
  await client.query('commit');
  console.log(`Created restaurant "${restaurant}" with owner ${email}. You can now log in.`);
} catch (err) {
  await client.query('rollback');
  console.error(err.code === '23505' ? 'This email is already used.' : `Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
