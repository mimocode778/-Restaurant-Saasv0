import { describe, expect, it } from 'vitest';
import { bearerToken, cookieToken, sameSiteRequest } from './auth.guard.js';
import { clearedSessionCookie, sessionCookie } from './cookies.js';

const TOKEN = 'a'.repeat(43);

describe('reading the login token', () => {
  it('from the Authorization header', () => {
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerToken(`bearer ${TOKEN}`)).toBeNull();
    expect(bearerToken('Bearer short')).toBeNull();
    expect(bearerToken(`Bearer ${TOKEN}; drop table`)).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it('from the cookie', () => {
    expect(cookieToken(`theme=dark; sid=${TOKEN}`)).toBe(TOKEN);
    expect(cookieToken('sid=')).toBeNull();
    expect(cookieToken('other=1')).toBeNull();
  });
});

describe('cookie settings', () => {
  it('cannot be read by page scripts, and is never sent by other websites', () => {
    const c = sessionCookie(TOKEN, new Date(Date.now() + 3600_000));
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toMatch(/Max-Age=(3599|3600)/);
  });

  it('logout empties it', () => {
    expect(clearedSessionCookie()).toContain('Max-Age=0');
  });
});

describe('requests sent with a cookie must come from our own website', () => {
  it('accepts the app address and refuses others', () => {
    expect(sameSiteRequest({ origin: 'http://localhost:5173' })).toBe(true);
    expect(sameSiteRequest({ referer: 'http://localhost:5173/caisse' })).toBe(true);
    expect(sameSiteRequest({ origin: 'https://evil.example' })).toBe(false);
    expect(sameSiteRequest({})).toBe(false);
    expect(sameSiteRequest({ referer: 'not a url' })).toBe(false);
  });
});
