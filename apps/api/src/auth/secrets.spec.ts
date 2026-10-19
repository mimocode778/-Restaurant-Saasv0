import { describe, expect, it } from 'vitest';
import { hashSecret, hashToken, newToken, verifySecret } from './secrets.js';

describe('password and PIN hashing', () => {
  it('accepts the right secret and refuses a wrong one', async () => {
    const stored = await hashSecret('correct horse battery');
    expect(stored).not.toContain('correct horse battery');
    expect(await verifySecret('correct horse battery', stored)).toBe(true);
    expect(await verifySecret('correct horse batterY', stored)).toBe(false);
  });

  it('gives a different hash each time for the same secret (random salt)', async () => {
    expect(await hashSecret('1234')).not.toBe(await hashSecret('1234'));
  });

  it('refuses damaged or foreign hashes instead of crashing', async () => {
    for (const bad of ['', 'plain', 'bcrypt$x', 'scrypt$1$2$3$aa$bb', 'scrypt$99999999$8$1$aa$' + 'a'.repeat(43)]) {
      expect(await verifySecret('x', bad)).toBe(false);
    }
  });
});

describe('tokens', () => {
  it('are long, random and only their fingerprint is stored', () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).toBe(hashToken(a));
  });
});
