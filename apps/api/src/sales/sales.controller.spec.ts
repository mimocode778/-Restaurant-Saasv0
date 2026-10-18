import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SalesController } from './sales.controller.js';
import type { SalesService } from './sales.service.js';

const RESTAURANT = '11111111-1111-1111-1111-111111111111';
const valid = { occurredAt: '2026-10-19T12:00:00+01:00', kind: 'sale', amountMillimes: 12500 };

function setup() {
  const service = {
    record: vi.fn().mockResolvedValue({ duplicate: false }),
    summary: vi.fn().mockResolvedValue({ tickets: 0, grossMillimes: 0, netMillimes: 0 }),
  };
  const controller = new SalesController(service as unknown as SalesService);
  return { controller, service };
}

describe('POST /sales', () => {
  it('passes a valid sale to the service as a manual sale for that restaurant', async () => {
    const { controller, service } = setup();
    await controller.create(RESTAURANT, valid);
    expect(service.record).toHaveBeenCalledWith(RESTAURANT, {
      occurredAt: new Date('2026-10-19T12:00:00+01:00'),
      kind: 'sale',
      amountMillimes: 12500,
      source: 'manual',
      externalRef: undefined,
    });
  });

  it.each([
    ['a missing restaurant header', undefined, valid],
    ['an invalid restaurant header', 'abc', valid],
    ['a decimal amount', RESTAURANT, { ...valid, amountMillimes: 12.5 }],
    ['an amount as text', RESTAURANT, { ...valid, amountMillimes: '12500' }],
    ['an absurdly large amount', RESTAURANT, { ...valid, amountMillimes: 5_000_000_000_000 }],
    ['a negative sale', RESTAURANT, { ...valid, amountMillimes: -100 }],
    ['a positive refund', RESTAURANT, { ...valid, kind: 'refund', amountMillimes: 100 }],
    ['an unknown kind', RESTAURANT, { ...valid, kind: 'gift' }],
    ['a date without a time', RESTAURANT, { ...valid, occurredAt: '2026-10-19' }],
    ['a null date', RESTAURANT, { ...valid, occurredAt: null }],
    ['a client-chosen source', RESTAURANT, { ...valid, source: 'register' }],
    ['a client-chosen restaurant in the body', RESTAURANT, { ...valid, restaurantId: RESTAURANT }],
    ['no body at all', RESTAURANT, undefined],
  ])('rejects %s', async (_name, header, body) => {
    const { controller, service } = setup();
    await expect(controller.create(header, body)).rejects.toBeInstanceOf(BadRequestException);
    expect(service.record).not.toHaveBeenCalled();
  });
});

describe('GET /sales/summary', () => {
  it('uses today in Tunisian time when no day is given', async () => {
    const { controller, service } = setup();
    await controller.summary(RESTAURANT, undefined);
    expect(service.summary).toHaveBeenCalledWith(RESTAURANT, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('passes a valid day through', async () => {
    const { controller, service } = setup();
    await controller.summary(RESTAURANT, '2026-10-19');
    expect(service.summary).toHaveBeenCalledWith(RESTAURANT, '2026-10-19');
  });

  it('rejects a badly formatted day and a missing restaurant', async () => {
    const { controller } = setup();
    await expect(controller.summary(RESTAURANT, '19/10/2026')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.summary(undefined, '2026-10-19')).rejects.toBeInstanceOf(BadRequestException);
  });
});
