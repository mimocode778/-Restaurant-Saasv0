import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

// Applies every migration not applied yet, each in its own transaction, in name order.
// Returns false if one failed (the ones after it are not run).
export async function migrate(url, log = console.log) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) {
        log('skip   ', file);
        continue;
      }
      const sql = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        log('applied', file);
      } catch (err) {
        await client.query('rollback');
        console.error('FAILED ', file, '-', err.message);
        return false;
      }
    }
    return true;
  } finally {
    await client.end();
  }
}
