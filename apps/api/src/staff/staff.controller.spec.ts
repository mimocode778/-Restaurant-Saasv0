import { describe, expect, it } from 'vitest';
import { canManage, NewStaff } from './staff.controller.js';

describe('who may add or disable whom', () => {
  it('an owner manages managers and waiters, never another owner', () => {
    expect(canManage('owner', 'manager')).toBe(true);
    expect(canManage('owner', 'waiter')).toBe(true);
    expect(canManage('owner', 'owner')).toBe(false);
  });

  it('a manager manages waiters only', () => {
    expect(canManage('manager', 'waiter')).toBe(true);
    expect(canManage('manager', 'manager')).toBe(false);
    expect(canManage('manager', 'owner')).toBe(false);
  });

  it('a waiter manages nobody', () => {
    expect(canManage('waiter', 'waiter')).toBe(false);
  });
});

describe('new staff member', () => {
  const ok = (v: unknown) => NewStaff.safeParse(v).success;

  it('a waiter needs a PIN of 4 to 6 digits', () => {
    expect(ok({ fullName: 'Sami', role: 'waiter', pin: '4821' })).toBe(true);
    expect(ok({ fullName: 'Sami', role: 'waiter' })).toBe(false);
    expect(ok({ fullName: 'Sami', role: 'waiter', pin: '12' })).toBe(false);
    expect(ok({ fullName: 'Sami', role: 'waiter', pin: 'abcd' })).toBe(false);
  });

  it('a manager needs an email and a long enough password, and no PIN', () => {
    expect(ok({ fullName: 'Leila', role: 'manager', email: 'l@x.tn', password: 'longenough1' })).toBe(true);
    expect(ok({ fullName: 'Leila', role: 'manager', email: 'l@x.tn', password: 'short' })).toBe(false);
    expect(ok({ fullName: 'Leila', role: 'manager' })).toBe(false);
    expect(ok({ fullName: 'Leila', role: 'manager', email: 'l@x.tn', password: 'longenough1', pin: '1234' })).toBe(false);
  });

  it('nobody can be created as an owner, and unknown fields are refused', () => {
    expect(ok({ fullName: 'X', role: 'owner', email: 'o@x.tn', password: 'longenough1' })).toBe(false);
    expect(ok({ fullName: 'Sami', role: 'waiter', pin: '4821', restaurantId: 'x' })).toBe(false);
  });
});
