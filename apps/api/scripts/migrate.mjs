import pg from 'pg';
import { adminDatabaseUrl } from './db-url.mjs';
import { migrate } from './migrate-lib.mjs';

const url = adminDatabaseUrl();
if (!(await migrate(url))) {
  process.exitCode = 1;
} else if (process.env.NODE_ENV === 'production') {
  // Safety check on a server: the API's limited account must not still have its
  // development password. If logging in with it works, stop and say what to do.
  const probe = new URL(url);
  probe.username = 'app_runtime';
  probe.password = 'app_runtime';
  const client = new pg.Client({ connectionString: probe.toString(), connectionTimeoutMillis: 5000 });
  let devPasswordWorks = false;
  try {
    await client.connect();
    devPasswordWorks = true;
  } catch {
    devPasswordWorks = false;
  } finally {
    await client.end().catch(() => {});
  }
  if (devPasswordWorks) {
    console.error('DANGER: the app_runtime account still has its development password. Run: pnpm --filter api set-runtime-password');
    process.exitCode = 1;
  }
}
