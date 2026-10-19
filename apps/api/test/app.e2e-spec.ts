import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript helper shared with `pnpm db:migrate`
import { migrate } from '../scripts/migrate-lib.mjs';
import { AppModule } from '../src/app.module.js';
import { hashSecret } from '../src/auth/secrets.js';

// The whole API, over HTTP, against a brand-new database that is deleted at the end,
// so the append-only tables of your development database stay clean.
const ADMIN_URL = new URL(process.env.ADMIN_DATABASE_URL ?? 'postgresql://app:app@localhost:15432/restaurant');
const DB_NAME = `restaurant_e2e_${Date.now()}`;
const adminUrlFor = (db: string) => Object.assign(new URL(ADMIN_URL), { pathname: `/${db}` }).toString();

let app: INestApplication;
let admin: Client;
let savedUrl: string | undefined;

const PASSWORD = 'a long password';
async function createOwner(restaurant: string, email: string) {
  const r = (await admin.query('insert into restaurants (name) values ($1) returning id', [restaurant])).rows[0].id;
  const u = (await admin.query(`insert into users (restaurant_id, full_name, role) values ($1, 'Owner', 'owner') returning id`, [r])).rows[0].id;
  await admin.query('insert into credentials (user_id, restaurant_id, email, password_hash) values ($1, $2, $3, $4)', [u, r, email, await hashSecret(PASSWORD)]);
  return r as string;
}

beforeAll(async () => {
  const setup = new Client({ connectionString: ADMIN_URL.toString() });
  await setup.connect();
  await setup.query(`create database ${DB_NAME}`);
  await setup.end();
  expect(await migrate(adminUrlFor(DB_NAME), () => {})).toBe(true);

  admin = new Client({ connectionString: adminUrlFor(DB_NAME) });
  await admin.connect();

  savedUrl = process.env.DATABASE_URL;
  const runtime = new URL(adminUrlFor(DB_NAME));
  runtime.username = 'app_runtime';
  runtime.password = 'app_runtime';
  process.env.DATABASE_URL = runtime.toString();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await admin?.end();
  if (savedUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedUrl;
  const cleanup = new Client({ connectionString: ADMIN_URL.toString() });
  await cleanup.connect();
  await cleanup.query(`drop database if exists ${DB_NAME} with (force)`);
  await cleanup.end();
});

const http = () => request(app.getHttpServer());
const login = async (email: string, password = PASSWORD) =>
  (await http().post('/auth/login').send({ email, password }).expect(200)).body.token as string;
const sale = { occurredAt: '2026-10-19T12:00:00+01:00', kind: 'sale', amountMillimes: 12500 };

describe('the API is closed by default', () => {
  it('answers the health check without login', () => http().get('/').expect(200, { status: 'ok' }));

  it('refuses everything else without login', async () => {
    await http().get('/sales/summary').expect(401);
    await http().post('/sales').send(sale).expect(401);
    await http().get('/staff').expect(401);
    await http().get('/sales/summary').set('authorization', 'Bearer not-a-real-token-at-all').expect(401);
  });

  it('ignores the old x-restaurant-id header completely', async () => {
    const r = await createOwner('Header', 'header@test.tn');
    await http().get('/sales/summary').set('x-restaurant-id', r).expect(401);
  });
});

describe('owners log in and only ever see their own restaurant', () => {
  it('two restaurants never see each other\'s sales', async () => {
    await createOwner('Resto A', 'a@test.tn');
    await createOwner('Resto B', 'b@test.tn');
    const a = await login('a@test.tn');
    const b = await login('b@test.tn');

    await http().post('/sales').set('authorization', `Bearer ${a}`).send(sale).expect(201);
    await http().post('/sales').set('authorization', `Bearer ${b}`).send({ ...sale, amountMillimes: 99000 }).expect(201);

    const summaryA = await http().get('/sales/summary?day=2026-10-19').set('authorization', `Bearer ${a}`).expect(200);
    expect(summaryA.body).toEqual({ tickets: 1, grossMillimes: 12500, netMillimes: 12500 });
  });

  it('refuses a wrong password, then blocks after 5 wrong tries', async () => {
    await createOwner('Resto C', 'c@test.tn');
    for (let i = 0; i < 5; i++) {
      await http().post('/auth/login').send({ email: 'c@test.tn', password: 'wrong password' }).expect(401);
    }
    await http().post('/auth/login').send({ email: 'c@test.tn', password: PASSWORD }).expect(429);
  });

  it('gives the same answer for an unknown email as for a wrong password', async () => {
    const res = await http().post('/auth/login').send({ email: 'nobody@test.tn', password: 'whatever' }).expect(401);
    expect(res.body.message).toBe('Wrong email or password');
  });

  it('logging out ends the session', async () => {
    await createOwner('Resto D', 'd@test.tn');
    const t = await login('d@test.tn');
    await http().get('/auth/me').set('authorization', `Bearer ${t}`).expect(200);
    await http().post('/auth/logout').set('authorization', `Bearer ${t}`).expect(204);
    await http().get('/auth/me').set('authorization', `Bearer ${t}`).expect(401);
  });
});

describe('waiters on a paired tablet', () => {
  it('pair a tablet, add a waiter, log in with the PIN, and stay within the waiter\'s rights', async () => {
    await createOwner('Resto E', 'e@test.tn');
    const owner = await login('e@test.tn');
    const auth = { authorization: `Bearer ${owner}` };

    const waiter = (await http().post('/staff').set(auth).send({ fullName: 'Sami', role: 'waiter', pin: '4821' }).expect(201)).body;
    const { deviceToken } = (await http().post('/auth/devices').set(auth).send({ name: 'Bar' }).expect(201)).body;

    const names = await http().get('/auth/device/staff').set('x-device-token', deviceToken).expect(200);
    expect(names.body).toEqual([{ userId: waiter.id, fullName: 'Sami' }]);

    await http().post('/auth/pin-login').set('x-device-token', deviceToken).send({ userId: waiter.id, pin: '0000' }).expect(401);
    await http().post('/auth/pin-login').send({ userId: waiter.id, pin: '4821' }).expect(401);
    const w = (await http().post('/auth/pin-login').set('x-device-token', deviceToken).send({ userId: waiter.id, pin: '4821' }).expect(200)).body.token;
    const asWaiter = { authorization: `Bearer ${w}` };

    await http().post('/sales').set(asWaiter).send(sale).expect(201);
    await http().post('/sales').set(asWaiter).send({ ...sale, kind: 'refund', amountMillimes: -500 }).expect(403);
    await http().get('/staff').set(asWaiter).expect(403);
    await http().post('/auth/devices').set(asWaiter).send({ name: 'Mine' }).expect(403);

    // The owner lets the waiter go: their session stops working at once.
    await http().post(`/staff/${waiter.id}/disable`).set(auth).expect(204);
    await http().get('/auth/me').set(asWaiter).expect(401);
  });

  it('a tablet of restaurant F cannot log in a waiter of restaurant G', async () => {
    await createOwner('Resto F', 'f@test.tn');
    await createOwner('Resto G', 'g@test.tn');
    const f = { authorization: `Bearer ${await login('f@test.tn')}` };
    const g = { authorization: `Bearer ${await login('g@test.tn')}` };
    const tabletF = (await http().post('/auth/devices').set(f).send({ name: 'F' }).expect(201)).body.deviceToken;
    const waiterG = (await http().post('/staff').set(g).send({ fullName: 'Gwaiter', role: 'waiter', pin: '1111' }).expect(201)).body;
    await http().post('/auth/pin-login').set('x-device-token', tabletF).send({ userId: waiterG.id, pin: '1111' }).expect(401);
    const namesF = await http().get('/auth/device/staff').set('x-device-token', tabletF).expect(200);
    expect(namesF.body).toEqual([]);
  });
});

describe('staff management rules', () => {
  it('an owner adds a manager who can log in; a manager cannot add a manager', async () => {
    await createOwner('Resto H', 'h@test.tn');
    const owner = { authorization: `Bearer ${await login('h@test.tn')}` };
    await http().post('/staff').set(owner).send({ fullName: 'Leila', role: 'manager', email: 'leila@test.tn', password: 'another long one' }).expect(201);
    await http().post('/staff').set(owner).send({ fullName: 'Copy', role: 'manager', email: 'LEILA@test.tn', password: 'another long one' }).expect(409);

    const manager = { authorization: `Bearer ${await login('leila@test.tn', 'another long one')}` };
    await http().post('/staff').set(manager).send({ fullName: 'Nope', role: 'manager', email: 'nope@test.tn', password: 'another long one' }).expect(403);
    await http().post('/staff').set(manager).send({ fullName: 'Ok', role: 'waiter', pin: '2222' }).expect(201);
    const list = (await http().get('/staff').set(manager).expect(200)).body;
    expect(list.map((s: { fullName: string }) => s.fullName).sort()).toEqual(['Leila', 'Ok', 'Owner']);
  });
});
