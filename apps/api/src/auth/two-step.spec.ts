import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUrl,
  totpCode,
} from './two-step.js';

// Official test values from the standard (RFC 6238, appendix B), last 6 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('phone-app codes', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the standard at time %i', (seconds, code) => {
    expect(totpCode(RFC_SECRET, Math.floor(seconds / 30))).toBe(code);
  });

  it('accepts the current code and the neighbouring ones, nothing else', () => {
    const secret = newTotpSecret();
    const now = Date.now();
    const step = Math.floor(now / 30_000);
    expect(matchTotp(secret, totpCode(secret, step), now)).toBe(step);
    expect(matchTotp(secret, totpCode(secret, step - 1), now)).toBe(step - 1);
    expect(matchTotp(secret, totpCode(secret, step + 1), now)).toBe(step + 1);
    expect(matchTotp(secret, totpCode(secret, step - 3), now)).toBeNull();
    expect(matchTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('base32 goes back and forth', () => {
    const buf = randomBytes(20);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });

  it('builds the link phone apps understand', () => {
    expect(otpauthUrl('ABC', 'Ali Ben Salah')).toBe(
      'otpauth://totp/Restaurant%20SaaS%3AAli%20Ben%20Salah?secret=ABC&issuer=Restaurant%20SaaS&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('secret encryption', () => {
  const key = randomBytes(32);

  it('decrypts what it encrypted, and the stored form does not contain the secret', () => {
    const stored = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(stored).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(stored, key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses a wrong key or a modified value', () => {
    const stored = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(() => decryptSecret(stored, randomBytes(32))).toThrow();
    const parts = stored.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
  });
});

describe('recovery codes', () => {
  it('gives 10 different codes that read easily', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it('accepts a code typed in lower case or without dashes', () => {
    expect(hashRecoveryCode('abcd-efgh-jkmn')).toBe(hashRecoveryCode('ABCDEFGHJKMN'));
  });
});
