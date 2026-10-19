import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Passwords and PINs are stored as a slow, salted scrypt hash, never as themselves.
// Stored format: scrypt$N$r$p$<salt base64url>$<hash base64url>
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;

function scryptAsync(secret: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(secret, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isSafeInteger) || n > 1 << 20) return false;
  const expected = Buffer.from(parts[5], 'base64url');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await scryptAsync(secret, Buffer.from(parts[4], 'base64url'), n, r, p);
  return timingSafeEqual(actual, expected);
}

// Used when the email is unknown, so a wrong email takes as long as a wrong password
// and nobody can find out which emails have an account by timing the answer.
const DUMMY_HASH = hashSecret(randomBytes(16).toString('hex'));
export async function burnTime(secret: string): Promise<void> {
  await verifySecret(secret, await DUMMY_HASH);
}

// Session and tablet tokens: long random strings. Only their SHA-256 is stored, so a
// copy of the database cannot be used to log in.
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
