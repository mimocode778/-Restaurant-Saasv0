import { isProduction } from '../config.js';

// For the restaurant's web app, the login token is kept in a cookie the page's JavaScript
// cannot read (HttpOnly), so a malicious script on the page cannot steal it.
export const SESSION_COOKIE = 'sid';

export function sessionCookie(token: string, expiresAt: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    ...(isProduction() ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(): string {
  return [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', ...(isProduction() ? ['Secure'] : [])].join('; ');
}

export function readCookie(header: unknown, name: string): string | null {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}
