import { createHash } from 'node:crypto';

// Settings read from environment variables. In production, unsafe or missing values stop
// the API from starting, instead of quietly running with development defaults.
export const isProduction = () => process.env.NODE_ENV === 'production';

const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

// Websites allowed to call the API from a browser (the restaurant app). Comma-separated.
export function allowedOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);
  if (raw && raw.length > 0) {
    if (isProduction() && raw.some((o) => !o.startsWith('https://'))) {
      throw new Error('CORS_ORIGINS must only contain https:// addresses in production');
    }
    return raw;
  }
  if (isProduction()) throw new Error('CORS_ORIGINS must be set in production');
  return DEV_ORIGINS;
}

// Key that encrypts the phone-app secrets of two-step login. 32 random bytes, base64.
// Create one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
export function authSecretKey(): Buffer {
  const raw = process.env.AUTH_SECRET_KEY;
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('AUTH_SECRET_KEY must be 32 bytes, base64-encoded');
    return key;
  }
  if (isProduction()) throw new Error('AUTH_SECRET_KEY must be set in production');
  // Development only: a fixed, publicly known key. Never used in production.
  return createHash('sha256').update('development-only-auth-secret-key').digest();
}

// Behind a reverse proxy (needed for HTTPS), tells the API how many proxies to trust so it
// sees the visitor's real address. 0 = no proxy.
export function trustedProxyHops(): number {
  const n = Number(process.env.TRUST_PROXY_HOPS ?? '0');
  if (!Number.isInteger(n) || n < 0 || n > 5) throw new Error('TRUST_PROXY_HOPS must be 0 to 5');
  return n;
}

// Checks done once at startup.
export function assertSafeConfig(): void {
  allowedOrigins();
  authSecretKey();
  trustedProxyHops();
}
