# Welcome to the project

Restaurant management software (SaaS) for **Tunisia**: menu, staff, dining room, then the
till, stock and customer database (CRM). The long-term goal is a **3D interface that feels
like a management video game**, on top of a serious, tax-compliant core.

This page explains what exists today, how the code is organised, the rules we follow, and
what comes next. Read it once before your first change.

---

## 1. Where we are (October 2026)

| Area | Status | What it does |
|---|---|---|
| Database foundation | ✅ Done | One database for all restaurants, each one strictly isolated (row-level security). Money tables are append-only. |
| Money and VAT | ✅ Done | All amounts are whole **millimes** (1 TND = 1000). VAT split to the millime. |
| Login and security | ✅ Done | Email + password for owners/managers, PIN on paired tablets for waiters, two-step login (phone app), attempt limits, login history, protected cookies. See `SECURITY.md`. |
| Staff | ✅ Done | Add, disable, reset PIN / password / two-step, by role. |
| Menu and prices | ✅ Done | Categories, dishes, prices including VAT, VAT rate per dish, price history. |
| Web screens (French) | ✅ Done | Login, home, menu, staff, tablets, login history, my account, dining room. |
| Dining room + 3D view | ✅ First version | Room editor (top view, drag and drop) and a low-poly 3D view (Three.js). Tables are always shown "free" for now. |
| Sales (basic) | 🟡 Started | Recording a sale and the day's totals. No till screen yet. |
| **Till (caisse)** | ⏳ Waiting | Blocked on the official specification, see section 6. |
| Offline mode | ⏳ To do | The till must keep working when the internet drops. |
| Stock | ⏳ To do | Tables exist (`stock_items`, `stock_movements`), no screens or API yet. |
| CRM (customers, loyalty) | ⏳ To do | Check Tunisian personal-data rules before storing customer data. |
| 3D game layer | ⏳ To do | Characters, animations, live table status, team challenges. |
| Hosting / production | ⏳ To do | Checklist in `SECURITY.md`. |

Tests: about 180 automatic checks (`pnpm test`, `pnpm test:e2e`), and `pnpm audit` reports
no known vulnerability.

---

## 2. The big picture

```
 Browser (owner, manager, waiter)
   │  apps/web  — React website in French, Vite, Three.js for the 3D room
   │  calls /api/...  (same website, protected login cookie)
   ▼
 API server
   │  apps/api  — NestJS (TypeScript). Checks the login, the role, the input,
   │  then runs each action as one database transaction for ONE restaurant
   ▼
 PostgreSQL database (Docker on your PC)
      apps/api/db/migrations — the tables, the security rules, the login functions

 packages/shared — code used by both sides: money in millimes, VAT split, parsing
```

The **till core** (recording sales, tickets, fiscal module, link to the Ministry) will be a
small, strict part. Everything else — including all the 3D — only *displays* data or *asks*
the core to do things. That way the 3D can change freely without touching the approved till.

---

## 3. The files

```
restaurant-saas/
├── README.md              How to install, run and use the API (start here)
├── SECURITY.md            What protects the accounts + go-live checklist (read before production)
├── docs/ONBOARDING.md     This page
├── CONTRIBUTING.md        Rules for every change
├── docker-compose.yml     Starts the PostgreSQL database on port 15432
├── package.json           Commands for the whole project (pnpm test, pnpm dev:api, ...)
│
├── packages/shared/src/   Shared by the API and the website
│   ├── money.ts           Millimes: add, multiply, split, format "12,500 TND", parse "12,5"
│   └── vat.ts             VAT rates in basis points (19 % = 1900), split price incl. VAT
│
├── apps/api/              The server
│   ├── db/migrations/     The database, in order (never edit an applied file, add a new one)
│   │   ├── 001_init.sql             Restaurants, users, stock, sales, isolation, append-only
│   │   ├── 002_restaurant_details.sql
│   │   ├── 003_auth.sql             Passwords, PINs, tablets, sessions (secret tables)
│   │   ├── 004_auth_hardening.sql   Attempt limits, login history, two-step, idle timeout
│   │   ├── 005_menu.sql             Categories, dishes, append-only price history
│   │   └── 006_floor.sql            Dining room size and items (tables, counter...)
│   ├── scripts/           migrate, create-owner, reset-owner-password
│   ├── src/
│   │   ├── main.ts / app.module.ts / app.setup.ts   Start-up, security headers, CORS
│   │   ├── config.ts      Settings; refuses unsafe production settings
│   │   ├── common/        Request validation helper (zod)
│   │   ├── db/            DbService: withRestaurant(...) — the ONLY way to touch data
│   │   ├── auth/          Login, sessions, guard (closed by default), roles, two-step, cookies
│   │   ├── staff/         Team management
│   │   ├── menu/          Menu and prices
│   │   ├── floor/         Dining room layout
│   │   └── sales/         Sales events and day summary
│   └── test/app.e2e-spec.ts   Full HTTP tests on a temporary database
│
└── apps/web/              The website
    ├── vite.config.ts     Forwards /api to the server (port 3000)
    └── src/
        ├── App.tsx        Navigation and pages by role
        ├── api.ts         Calls to the API + French error messages
        ├── floor.ts       Room geometry shared by the plan and the 3D view
        ├── ui.tsx / helpers.ts   Small components and helpers
        └── pages/         Login, Dashboard, Menu, Staff, Tablets, History, Account,
                           Room (plan editor), Room3D (3D view, loaded on demand)
```

Each module in `apps/api/src` follows the same pattern:
`*.controller.ts` (HTTP routes + input checks) → `*.service.ts` (one transaction per action)
→ `*.repository.ts` (SQL) → database rules in the migrations.

---

## 4. Rules that must never be broken

1. **Money is always whole millimes** (integers). Never use decimals for amounts. Use the
   helpers in `packages/shared`.
2. **The restaurant comes from the login, never from the request.** Every data access goes
   through `db.withRestaurant(user.restaurantId, ...)`. The database also enforces it.
3. **Sales, stock movements, prices and the login history are never edited or deleted.**
   A correction is a new row (e.g. a refund is a negative sale). Triggers block edits even
   for the admin. Tax rules on cash registers require this.
4. **Every route needs a login** unless explicitly marked `@Public()`. Use `@Roles(...)` for
   owner/manager-only actions.
5. **Validate every input** with a strict zod schema (unknown fields are refused).
6. **Never edit an applied migration.** Add a new numbered file.
7. **No secret in the code**: real passwords, keys and customer data stay out of Git.
8. **Every change comes with tests**, and `pnpm test`, `pnpm test:e2e` must pass.

---

## 5. Running it

See `README.md`. In short: install Git, Node.js, pnpm and Docker Desktop, then

```bash
pnpm install
docker compose up -d
pnpm db:migrate
pnpm test
pnpm create-owner --restaurant "Test" --name "Your Name" --email you@example.tn
pnpm dev:api        # window 1
pnpm dev:web        # window 2, then open http://localhost:5173
```

---

## 6. The till and the homologation (important context)

Since **1 July 2026**, restaurants and cafés run by companies in Tunisia must record on-site
sales on a cash register system **approved by the Ministry of Finance** (government decree
2019-1126 and the order of 14 October 2025). The decree requires, among other things: no
editing or deleting of recorded operations, a fiscal module, permanent connection to the
Ministry's platform, defined ticket contents (ticket number, fiscal module ID, lines before
tax, VAT amounts and rates, payment method, QR code) and daily reports.

We chose to **become an approved supplier**. The official specification (*Cahier des charges
techniques et fonctionnelles*) and the *Manuel des procédures techniques* are obtained by
registering on **https://homologation.nacef.tn**. The till core will be built from those
documents. **Do not build till/ticket features before we have them.**

---

## 7. What comes next

1. Till core, built to the official specification, with offline mode and the link to the
   Ministry (integration tests on the homologation portal).
2. Hosting online (HTTPS, backups, monitoring) and a pilot with 1–2 restaurants.
3. Stock, then the CRM.
4. 3D game layer: live table status, staff characters, animations, team challenges.

Good first tasks while waiting for the specification: stock API and screens, tests on a
real tablet for the 3D view, editing an owner's name from the screens.
