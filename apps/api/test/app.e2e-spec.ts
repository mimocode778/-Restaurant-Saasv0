import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript helper shared with `pnpm db:migrate`
import { migrate } from '../scripts/migrate-lib.mjs';
import { AppModule } from '../src/app.module.js';
import { configure } from '../src/app.setup.js';
import { hashSecret } from '../src/auth/secrets.js';
import { currentStep, totpCode } from '../src/auth/two-step.js';

// The whole API, over HTTP, against a brand-new database that is deleted at the end,
// so the append-only tables of your development database stay clean.
const ADMIN_URL = new URL(process.env.ADMIN_DATABASE_URL ?? 'postgresql://app:app@localhost:15432/restaurant');
const DB_NAME = `restaurant_e2e_${Date.now()}`;
const adminUrlFor = (db: string) => Object.assign(new URL(ADMIN_URL), { pathname: `/${db}` }).toString();
const APP_ORIGIN = 'http://localhost:5173';

let app: NestExpressApplication;
let admin: Client;
const savedEnv = { ...process.env };

const PASSWORD = 'a long password for tests';
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

  const runtime = new URL(adminUrlFor(DB_NAME));
  runtime.username = 'app_runtime';
  runtime.password = 'app_runtime';
  process.env.DATABASE_URL = runtime.toString();
  // Lets each test pretend to come from its own network address.
  process.env.TRUST_PROXY_HOPS = '1';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configure(app);
  await app.init();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await admin?.end();
  process.env = { ...savedEnv };
  const cleanup = new Client({ connectionString: ADMIN_URL.toString() });
  await cleanup.connect();
  await cleanup.query(`drop database if exists ${DB_NAME} with (force)`);
  await cleanup.end();
});

let ipCounter = 0;
const newIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

// Every request comes from a fresh address unless a test says otherwise.
function http(ip = newIp()) {
  const agent = request(app.getHttpServer());
  const wrap = <T extends { set(k: string, v: string): T }>(r: T) => r.set('x-forwarded-for', ip);
  return {
    get: (u: string) => wrap(agent.get(u)),
    post: (u: string) => wrap(agent.post(u)),
    options: (u: string) => wrap(agent.options(u)),
  };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
async function login(email: string, password = PASSWORD, extra: Record<string, unknown> = {}) {
  return (await http().post('/auth/login').send({ email, password, ...extra }).expect(200)).body.token as string;
}
const sale = { occurredAt: '2026-10-19T12:00:00+01:00', kind: 'sale', amountMillimes: 12500 };

describe('the API is closed by default', () => {
  it('answers the health check without login', () => http().get('/').expect(200, { status: 'ok' }));

  it('refuses everything else without login', async () => {
    await http().get('/sales/summary').expect(401);
    await http().post('/sales').send(sale).expect(401);
    await http().get('/staff').expect(401);
    await http().get('/auth/events').expect(401);
    await http().get('/sales/summary').set('authorization', 'Bearer not-a-real-token-at-all').expect(401);
  });

  it('ignores the old x-restaurant-id header completely', async () => {
    const r = await createOwner('Header', 'header@test.tn');
    await http().get('/sales/summary').set('x-restaurant-id', r).expect(401);
  });
});

describe('browser protections', () => {
  it('sends the standard protection headers and hides the server type', async () => {
    const res = await http().get('/').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('lets only our own website call the API from a browser', async () => {
    const ours = await http().options('/auth/login').set('origin', APP_ORIGIN).set('access-control-request-method', 'POST');
    expect(ours.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    const theirs = await http().options('/auth/login').set('origin', 'https://evil.example').set('access-control-request-method', 'POST');
    expect(theirs.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses oversized requests', async () => {
    await http().post('/auth/login').set('content-type', 'application/json').send(JSON.stringify({ email: 'x'.repeat(200_000) })).expect(413);
  });
});

describe('owners log in and only ever see their own restaurant', () => {
  it('two restaurants never see each other\'s sales', async () => {
    await createOwner('Resto A', 'a@test.tn');
    await createOwner('Resto B', 'b@test.tn');
    const a = await login('a@test.tn');
    const b = await login('b@test.tn');
    await http().post('/sales').set(bearer(a)).send(sale).expect(201);
    await http().post('/sales').set(bearer(b)).send({ ...sale, amountMillimes: 99000 }).expect(201);
    const summaryA = await http().get('/sales/summary?day=2026-10-19').set(bearer(a)).expect(200);
    expect(summaryA.body).toEqual({ tickets: 1, grossMillimes: 12500, netMillimes: 12500 });
  });

  it('gives the same answer for an unknown email as for a wrong password', async () => {
    const res = await http().post('/auth/login').send({ email: 'nobody@test.tn', password: 'whatever' }).expect(401);
    expect(res.body.message).toBe('Wrong email or password');
  });

  it('logging out ends the session', async () => {
    await createOwner('Resto D', 'd@test.tn');
    const t = await login('d@test.tn');
    await http().get('/auth/me').set(bearer(t)).expect(200);
    await http().post('/auth/logout').set(bearer(t)).expect(204);
    await http().get('/auth/me').set(bearer(t)).expect(401);
  });
});

describe('attempt limits', () => {
  it('5 wrong passwords from one place block that account from that place only', async () => {
    await createOwner('Resto C', 'c@test.tn');
    const attacker = newIp();
    for (let i = 0; i < 5; i++) {
      await http(attacker).post('/auth/login').send({ email: 'c@test.tn', password: 'wrong password' }).expect(401);
    }
    await http(attacker).post('/auth/login').send({ email: 'c@test.tn', password: PASSWORD }).expect(429);
    // The real owner, somewhere else, can still log in.
    await login('c@test.tn');
  });

  it('behaves exactly the same for an email that has no account', async () => {
    const attacker = newIp();
    for (let i = 0; i < 5; i++) {
      await http(attacker).post('/auth/login').send({ email: 'ghost@test.tn', password: 'wrong password' }).expect(401);
    }
    await http(attacker).post('/auth/login').send({ email: 'ghost@test.tn', password: 'wrong password' }).expect(429);
  });

  it('one network address cannot try many accounts', async () => {
    const attacker = newIp();
    for (let i = 0; i < 30; i++) {
      await http(attacker).post('/auth/login').send({ email: `spray${i}@test.tn`, password: 'Summer2026!' }).expect(401);
    }
    await http(attacker).post('/auth/login').send({ email: 'spray-last@test.tn', password: 'Summer2026!' }).expect(429);
  });

  it('many places guessing the same account eventually block it everywhere', async () => {
    await createOwner('Resto Z', 'z@test.tn');
    for (let i = 0; i < 20; i++) {
      await http().post('/auth/login').send({ email: 'z@test.tn', password: 'wrong password' }).expect(401);
    }
    await http().post('/auth/login').send({ email: 'z@test.tn', password: PASSWORD }).expect(429);
  });
});

describe('cookie login for the web app', () => {
  it('keeps the token out of reach of page scripts and refuses forged requests', async () => {
    await createOwner('Resto K', 'k@test.tn');
    // Another website cannot start a cookie login.
    await http().post('/auth/login').set('origin', 'https://evil.example').send({ email: 'k@test.tn', password: PASSWORD, useCookie: true }).expect(403);
    const res = await http().post('/auth/login').set('origin', APP_ORIGIN).send({ email: 'k@test.tn', password: PASSWORD, useCookie: true }).expect(200);
    expect(res.body.token).toBeUndefined();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const sid = cookie.split(';')[0];

    await http().get('/auth/me').set('cookie', sid).expect(200);
    // Another website making the browser send a sale: refused.
    await http().post('/sales').set('cookie', sid).set('origin', 'https://evil.example').send(sale).expect(403);
    await http().post('/sales').set('cookie', sid).send(sale).expect(403);
    // Our own app: accepted.
    await http().post('/sales').set('cookie', sid).set('origin', APP_ORIGIN).send(sale).expect(201);

    const out = await http().post('/auth/logout').set('cookie', sid).set('origin', APP_ORIGIN).expect(204);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
    await http().get('/auth/me').set('cookie', sid).expect(401);
  });
});

describe('two-step login with a phone app', () => {
  it('setup, login with a code, refuse a reused code, use a recovery code once', async () => {
    await createOwner('Resto T', 't@test.tn');
    const t = await login('t@test.tn');

    await http().post('/auth/two-step/setup').set(bearer(t)).send({ currentPassword: 'wrong password' }).expect(401);
    const { secret, otpauthUrl } = (await http().post('/auth/two-step/setup').set(bearer(t)).send({ currentPassword: PASSWORD }).expect(200)).body;
    expect(otpauthUrl).toContain(`secret=${secret}`);

    await http().post('/auth/two-step/confirm').set(bearer(t)).send({ code: '000000' }).expect(401);
    const step = currentStep();
    const { recoveryCodes } = (await http().post('/auth/two-step/confirm').set(bearer(t)).send({ code: totpCode(secret, step) }).expect(200)).body;
    expect(recoveryCodes).toHaveLength(10);
    expect((await http().get('/auth/me').set(bearer(t)).expect(200)).body.twoStepEnabled).toBe(true);

    // Password alone is no longer enough.
    const needCode = await http().post('/auth/login').send({ email: 't@test.tn', password: PASSWORD }).expect(401);
    expect(needCode.body.twoStepRequired).toBe(true);

    // The next code works once; the same code a second time does not.
    const next = totpCode(secret, step + 1);
    await login('t@test.tn', PASSWORD, { twoStepCode: next });
    const reused = await http().post('/auth/login').send({ email: 't@test.tn', password: PASSWORD, twoStepCode: next }).expect(401);
    expect(reused.body.message).toBe('Wrong code');

    // A recovery code works once.
    await login('t@test.tn', PASSWORD, { recoveryCode: recoveryCodes[0].toLowerCase() });
    await http().post('/auth/login').send({ email: 't@test.tn', password: PASSWORD, recoveryCode: recoveryCodes[0] }).expect(401);

    // A wrong password with a valid code still fails.
    await http().post('/auth/login').send({ email: 't@test.tn', password: 'wrong password', recoveryCode: recoveryCodes[1] }).expect(401);
  });

  it('waiters cannot turn on two-step login', async () => {
    await createOwner('Resto W2', 'w2@test.tn');
    const owner = await login('w2@test.tn');
    const waiter = (await http().post('/staff').set(bearer(owner)).send({ fullName: 'Sami', role: 'waiter', pin: '4821' }).expect(201)).body;
    const { deviceToken } = (await http().post('/auth/devices').set(bearer(owner)).send({ name: 'Bar' }).expect(201)).body;
    const w = (await http().post('/auth/pin-login').set('x-device-token', deviceToken).send({ userId: waiter.id, pin: '4821' }).expect(200)).body.token;
    await http().post('/auth/two-step/setup').set(bearer(w)).send({ currentPassword: 'x' }).expect(403);
  });
});

describe('password change and "log out everywhere"', () => {
  it('changing the password ends the other sessions and checks the new password', async () => {
    await createOwner('Resto P', 'p@test.tn');
    const here = await login('p@test.tn');
    const elsewhere = await login('p@test.tn');

    await http().post('/auth/password').set(bearer(here)).send({ currentPassword: 'wrong', newPassword: 'a brand new password' }).expect(401);
    await http().post('/auth/password').set(bearer(here)).send({ currentPassword: PASSWORD, newPassword: 'password123' }).expect(400);
    await http().post('/auth/password').set(bearer(here)).send({ currentPassword: PASSWORD, newPassword: 'a brand new password' }).expect(204);

    await http().get('/auth/me').set(bearer(here)).expect(200);
    await http().get('/auth/me').set(bearer(elsewhere)).expect(401);
    await http().post('/auth/login').send({ email: 'p@test.tn', password: PASSWORD }).expect(401);
    await login('p@test.tn', 'a brand new password');
  });

  it('"log out everywhere" ends every session, including this one', async () => {
    await createOwner('Resto Q', 'q@test.tn');
    const one = await login('q@test.tn');
    const two = await login('q@test.tn');
    const res = await http().post('/auth/logout-everywhere').set(bearer(one)).expect(200);
    expect(res.body.endedSessions).toBe(2);
    await http().get('/auth/me').set(bearer(one)).expect(401);
    await http().get('/auth/me').set(bearer(two)).expect(401);
  });
});

describe('waiters on a paired tablet', () => {
  it('pair a tablet, add a waiter, log in with the PIN, and stay within the waiter\'s rights', async () => {
    await createOwner('Resto E', 'e@test.tn');
    const auth = bearer(await login('e@test.tn'));

    const waiter = (await http().post('/staff').set(auth).send({ fullName: 'Sami', role: 'waiter', pin: '4821' }).expect(201)).body;
    const { deviceToken, deviceId } = (await http().post('/auth/devices').set(auth).send({ name: 'Bar' }).expect(201)).body;

    const names = await http().get('/auth/device/staff').set('x-device-token', deviceToken).expect(200);
    expect(names.body).toEqual([{ userId: waiter.id, fullName: 'Sami' }]);

    await http().post('/auth/pin-login').set('x-device-token', deviceToken).send({ userId: waiter.id, pin: '0000' }).expect(401);
    await http().post('/auth/pin-login').send({ userId: waiter.id, pin: '4821' }).expect(401);
    const w = (await http().post('/auth/pin-login').set('x-device-token', deviceToken).send({ userId: waiter.id, pin: '4821' }).expect(200)).body.token;
    const asWaiter = bearer(w);

    await http().post('/sales').set(asWaiter).send(sale).expect(201);
    await http().post('/sales').set(asWaiter).send({ ...sale, kind: 'refund', amountMillimes: -500 }).expect(403);
    await http().get('/staff').set(asWaiter).expect(403);
    await http().get('/auth/events').set(asWaiter).expect(403);
    await http().post('/auth/devices').set(asWaiter).send({ name: 'Mine' }).expect(403);
    await http().post('/auth/password').set(asWaiter).send({ currentPassword: 'x', newPassword: 'a brand new password' }).expect(403);

    // Unpairing the tablet ends the waiter's session on it.
    await http().post(`/auth/devices/${deviceId}/revoke`).set(auth).expect(204);
    await http().get('/auth/me').set(asWaiter).expect(401);
    await http().get('/auth/device/staff').set('x-device-token', deviceToken).expect(200, []);
  });

  it('5 wrong PINs block that waiter on that tablet', async () => {
    await createOwner('Resto L', 'l@test.tn');
    const auth = bearer(await login('l@test.tn'));
    const waiter = (await http().post('/staff').set(auth).send({ fullName: 'Hedi', role: 'waiter', pin: '1357' }).expect(201)).body;
    const { deviceToken } = (await http().post('/auth/devices').set(auth).send({ name: 'Salle' }).expect(201)).body;
    for (let i = 0; i < 5; i++) {
      await http().post('/auth/pin-login').set('x-device-token', deviceToken).send({ userId: waiter.id, pin: `000${i}` }).expect(401);
    }
    await http().post('/auth/pin-login').set('x-device-token', deviceToken).send({ userId: waiter.id, pin: '1357' }).expect(429);
  });

  it('a tablet of restaurant F cannot log in a waiter of restaurant G', async () => {
    await createOwner('Resto F', 'f@test.tn');
    await createOwner('Resto G', 'g@test.tn');
    const f = bearer(await login('f@test.tn'));
    const g = bearer(await login('g@test.tn'));
    const tabletF = (await http().post('/auth/devices').set(f).send({ name: 'F' }).expect(201)).body.deviceToken;
    const waiterG = (await http().post('/staff').set(g).send({ fullName: 'Gwaiter', role: 'waiter', pin: '1111' }).expect(201)).body;
    await http().post('/auth/pin-login').set('x-device-token', tabletF).send({ userId: waiterG.id, pin: '1111' }).expect(401);
    expect((await http().get('/auth/device/staff').set('x-device-token', tabletF).expect(200)).body).toEqual([]);
  });
});

describe('staff management rules', () => {
  it('owner adds a manager; a manager cannot add a manager; resets end sessions', async () => {
    await createOwner('Resto H', 'h@test.tn');
    const owner = bearer(await login('h@test.tn'));
    const leila = (await http().post('/staff').set(owner).send({ fullName: 'Leila', role: 'manager', email: 'leila@test.tn', password: 'another long one' }).expect(201)).body;
    await http().post('/staff').set(owner).send({ fullName: 'Copy', role: 'manager', email: 'LEILA@test.tn', password: 'another long one' }).expect(409);
    await http().post('/staff').set(owner).send({ fullName: 'Weak', role: 'manager', email: 'weak@test.tn', password: 'motdepasse123' }).expect(400);

    const managerToken = await login('leila@test.tn', 'another long one');
    const manager = bearer(managerToken);
    await http().post('/staff').set(manager).send({ fullName: 'Nope', role: 'manager', email: 'nope@test.tn', password: 'another long one' }).expect(403);
    const ok = (await http().post('/staff').set(manager).send({ fullName: 'Ok', role: 'waiter', pin: '2222' }).expect(201)).body;
    const list = (await http().get('/staff').set(manager).expect(200)).body;
    expect(list.map((s: { fullName: string }) => s.fullName).sort()).toEqual(['Leila', 'Ok', 'Owner']);

    // A manager can reset a waiter's PIN, not an owner's password.
    await http().post(`/staff/${ok.id}/reset-pin`).set(manager).send({ pin: '9999' }).expect(204);
    await http().post(`/staff/${leila.id}/reset-password`).set(manager).send({ newPassword: 'whatever long' }).expect(403);

    // The owner resets the manager's password: the manager's session ends.
    await http().post(`/staff/${leila.id}/reset-password`).set(owner).send({ newPassword: 'a fresh manager password' }).expect(204);
    await http().get('/auth/me').set(manager).expect(401);
    await login('leila@test.tn', 'a fresh manager password');

    // Disabling ends sessions too.
    const again = bearer(await login('leila@test.tn', 'a fresh manager password'));
    await http().post(`/staff/${leila.id}/disable`).set(owner).expect(204);
    await http().get('/auth/me').set(again).expect(401);
  });
});

describe('login history', () => {
  it('owners see what happened in their restaurant, with the network address', async () => {
    await createOwner('Resto V', 'v@test.tn');
    const ip = newIp();
    await http(ip).post('/auth/login').send({ email: 'v@test.tn', password: 'wrong password' }).expect(401);
    const t = (await http(ip).post('/auth/login').send({ email: 'v@test.tn', password: PASSWORD }).expect(200)).body.token;
    const events = (await http().get('/auth/events').set(bearer(t)).expect(200)).body;
    expect(events.map((e: { kind: string }) => e.kind).slice(0, 2)).toEqual(['login_succeeded', 'login_failed']);
    expect(events[0].ip).toBe(ip);
    expect(events[1].detail).toBe('wrong password');
  });

  it('never shows another restaurant\'s history', async () => {
    await createOwner('Resto X', 'x@test.tn');
    const t = await login('x@test.tn');
    const events = (await http().get('/auth/events').set(bearer(t)).expect(200)).body;
    expect(events.every((e: { fullName: string | null }) => e.fullName === 'Owner')).toBe(true);
  });
});
