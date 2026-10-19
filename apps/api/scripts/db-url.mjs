// The admin database address used by the scripts (migrations, accounts).
// On a developer's PC it falls back to the local Docker database.
// In production it must be given explicitly, so a script never acts on the wrong database.
export function adminDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (url) return url;
  if (process.env.NODE_ENV === 'production') {
    console.error('DATABASE_URL must be set in production (the admin account address). Nothing was done.');
    process.exit(1);
  }
  return 'postgresql://app:app@localhost:15432/restaurant';
}
