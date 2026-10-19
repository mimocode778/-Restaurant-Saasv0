import { isProduction } from '../config.js';

// For the restaurant's web app, the login token is kept in a cookie the page's JavaScript
// cannot read (HttpOnly), so a malicious script on the page cannot steal it.
// In production the name starts with "__Host-": browsers then only accept this cookie when
// it is Secure, set for the whole site and not shared with sub-sites, so nothing else can
// plant or overwrite it. (Without HTTPS on a developer's PC, the plain name is used.)
export function sessionCookieName(): string {
  return isProduction() ? '__Host-sid' : 'sid';
}

export function sessionCookie(token: string, expiresAt: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [
    `${sessionCookieName()}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    ...(isProduction() ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(): string {
  return [`${sessionCookieName()}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', ...(isProduction() ? ['Secure'] : [])].join('; ');
}

export function readCookie(header: unknown, name: string): string | null {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=') || null;
  }
  return null;
}
