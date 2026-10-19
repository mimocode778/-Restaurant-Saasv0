// Sets the password of "app_runtime", the limited database account the API uses.
// Migration 001 creates it with a development password ("app_runtime"): on a server,
// run this once, then put the same password in the API's DATABASE_URL.
//
//   pnpm --filter api set-runtime-password
//
// Uses the admin database account (DATABASE_URL). The password is asked for afterwards,
// so it does not stay in your terminal history.
// Create a strong one with: node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
import { createInterface } from 'node:readline/promises';
import pg from 'pg';
import { adminDatabaseUrl } from './db-url.mjs';

const MIN_LENGTH = 24;
const dbUrl = adminDatabaseUrl();

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = (await rl.question(`New password for app_runtime (at least ${MIN_LENGTH} characters, it will be visible): `)).trim();
rl.close();
if (password.length < MIN_LENGTH || password === 'app_runtime') {
  console.error(`Refused: use a random password of at least ${MIN_LENGTH} characters.`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
try {
  // format(%L) quotes the password safely inside the command.
  const { rows } = await client.query(`select format('alter role app_runtime password %L', $1::text) as sql`, [password]);
  await client.query(rows[0].sql);
  console.log('Password changed. Now update DATABASE_URL of the API with it, and restart the API.');
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
