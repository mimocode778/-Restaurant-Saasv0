import { describe, expect, it } from 'vitest';
import { passwordProblem } from './password-policy.js';

describe('password rules', () => {
  it('accepts a long, personal password', () => {
    expect(passwordProblem('le jasmin de Sidi Bou Said')).toBeNull();
    expect(passwordProblem('Couscous-du-vendredi-42')).toBeNull();
  });

  it.each([
    ['too short', 'short1'],
    ['a well-known password', 'password123'],
    ['a disguised well-known password', 'P@ssw0rd123'],
    ['a French classic', 'motdepasse123'],
    ['a keyboard row', 'azertyuiop'],
    ['the same characters again and again', 'aaaaaaaaaaaa'],
    ['far too long', 'x'.repeat(201)],
  ])('refuses %s', (_name, password) => {
    expect(passwordProblem(password)).not.toBeNull();
  });

  it('refuses a password that contains the email name', () => {
    expect(passwordProblem('ali.bensalah2026!', 'ali.bensalah@example.tn')).toMatch(/email/);
  });
});
