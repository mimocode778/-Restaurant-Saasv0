import { migrate } from './migrate-lib.mjs';

const url = process.env.DATABASE_URL ?? 'postgresql://app:app@localhost:15432/restaurant';
if (!(await migrate(url))) process.exitCode = 1;
