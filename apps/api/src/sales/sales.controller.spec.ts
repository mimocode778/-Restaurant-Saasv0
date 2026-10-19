import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { SessionUser } from '../auth/auth.repository.js';
import { describe, expect, it, vi } from 'vitest';
import { SalesController } from './sales.controller.js';
import type { SalesService } from './sales.service.js';

const RESTAURANT = '11111111-1111-1111-1111-111111111111';
const person = (role: SessionUser['role']): SessionUser => ({
  userId: '22222222-2222-2222-2222-222222222222',
  restaurantId: RESTAURANT,
  role,
  fullName: 'Test',
  method: role === 'waiter' ? 'pin' : 'password',
  twoStepEnabled: false,
  expiresAt: new Date(),
});
const manager = person('manager');
const waiter = person('waiter');
const valid = { kind: 'sale', amountMillimes: 12500 };
const SALE_ID = '33333333-3333-4333-8333-333333333333';

function setup() {
  const service = {
    record: vi.fn().mockResolvedValue({ duplicate: false }),
    summary: vi.fn().mockResolvedValue({ tickets: 0, grossMillimes: 0, netMillimes: 0 }),
  };
  const controller = new SalesController(service as unknown as SalesService);
  return { controller, service };
}

describe('POST /sales', () => {
  it('records the sale for the restaurant of the logged-in user, as a manual sale', async () => {
    const { controller, service } = setup();
    await controller.create(waiter, valid);
    expect(service.record).toHaveBeenCalledWith(RESTAURANT, {
      kind: 'sale',
      amountMillimes: 12500,
      source: 'manual',
      recordedBy: waiter.userId,
      refersTo: undefined,
      externalRef: undefined,
    });
  });

  it.each([
    ['a decimal amount', manager, { ...valid, amountMillimes: 12.5 }],
    ['an amount as text', manager, { ...valid, amountMillimes: '12500' }],
    ['an absurdly large amount', manager, { ...valid, amountMillimes: 5_000_000_000_000 }],
    ['a negative sale', manager, { ...valid, amountMillimes: -100 }],
    ['a positive refund', manager, { ...valid, kind: 'refund', amountMillimes: 100 }],
    ['an unknown kind', manager, { ...valid, kind: 'gift' }],
    ['a time chosen by the screen', manager, { ...valid, occurredAt: '2020-01-01T12:00:00Z' }],
    ['a refund without the sale it refers to', manager, { kind: 'refund', amountMillimes: -100 }],
    ['a sale that refers to another sale', manager, { ...valid, refersTo: SALE_ID }],
    ['a refund referring to something that is not an id', manager, { kind: 'refund', amountMillimes: -100, refersTo: 'abc' }],
    ['a person chosen by the screen', manager, { ...valid, recordedBy: SALE_ID }],
    ['a client-chosen source', manager, { ...valid, source: 'register' }],
    ['a client-chosen restaurant in the body', manager, { ...valid, restaurantId: RESTAURANT }],
    ['no body at all', manager, undefined],
  ])('rejects %s', async (_name, user, body) => {
    const { controller, service } = setup();
    await expect(controller.create(user, body)).rejects.toBeInstanceOf(BadRequestException);
    expect(service.record).not.toHaveBeenCalled();
  });
});

describe('who may take money back', () => {
  it.each(['void', 'discount', 'refund'])('a waiter cannot record a %s', async (kind) => {
    const { controller, service } = setup();
    await expect(controller.create(waiter, { ...valid, kind, amountMillimes: -100, refersTo: SALE_ID })).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.record).not.toHaveBeenCalled();
  });

  it.each(['owner', 'manager'] as const)('a %s can record a refund', async (role) => {
    const { controller, service } = setup();
    await controller.create(person(role), { kind: 'refund', amountMillimes: -100, refersTo: SALE_ID });
    expect(service.record).toHaveBeenCalledOnce();
  });
});

describe('GET /sales/summary', () => {
  it('uses today in Tunisian time when no day is given', async () => {
    const { controller, service } = setup();
    await controller.summary(waiter, undefined);
    expect(service.summary).toHaveBeenCalledWith(RESTAURANT, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('passes a valid day through', async () => {
    const { controller, service } = setup();
    await controller.summary(waiter, '2026-10-19');
    expect(service.summary).toHaveBeenCalledWith(RESTAURANT, '2026-10-19');
  });

  it('rejects a badly formatted day', async () => {
    const { controller } = setup();
    await expect(controller.summary(waiter, '19/10/2026')).rejects.toBeInstanceOf(BadRequestException);
  });
});
