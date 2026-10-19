import { afterEach, describe, expect, it } from 'vitest';
import { allowedOrigins, authSecretKey, trustedProxyHops } from './config.js';
import { DbService } from './db/db.service.js';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function production(vars: Record<string, string | undefined>) {
  process.env.NODE_ENV = 'production';
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('production refuses unsafe settings', () => {
  it('requires the list of allowed websites, in https', () => {
    production({ CORS_ORIGINS: undefined });
    expect(() => allowedOrigins()).toThrow(/CORS_ORIGINS must be set/);
    production({ CORS_ORIGINS: 'http://app.example.tn' });
    expect(() => allowedOrigins()).toThrow(/https/);
    production({ CORS_ORIGINS: 'https://app.example.tn' });
    expect(allowedOrigins()).toEqual(['https://app.example.tn']);
  });

  it('requires a real encryption key', () => {
    production({ AUTH_SECRET_KEY: undefined });
    expect(() => authSecretKey()).toThrow(/AUTH_SECRET_KEY must be set/);
    production({ AUTH_SECRET_KEY: Buffer.alloc(16).toString('base64') });
    expect(() => authSecretKey()).toThrow(/32 bytes/);
  });

  it.each([
    ['the development password', 'postgresql://app_runtime:app_runtime@db.example.tn/restaurant', 'true'],
    ['a short password', 'postgresql://app_runtime:shortpass@db.example.tn/restaurant', 'true'],
  ])('refuses %s for the database', (_name, url, ssl) => {
    production({ DATABASE_URL: url, DB_SSL: ssl });
    expect(() => new DbService()).toThrow(/development or short password/);
  });

  it('requires encrypted database traffic', () => {
    production({ DATABASE_URL: 'postgresql://app_runtime:a-very-long-random-password@db.example.tn/restaurant', DB_SSL: undefined });
    expect(() => new DbService()).toThrow(/DB_SSL=true/);
  });

  it('rejects a silly number of proxies', () => {
    process.env.TRUST_PROXY_HOPS = '99';
    expect(() => trustedProxyHops()).toThrow();
  });
});
