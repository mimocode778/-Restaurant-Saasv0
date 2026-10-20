# CLAUDE.md — instructions for Claude working on this project

Restaurant management SaaS for **Tunisia** (till, staff, menu, dining room, stock, CRM),
with a 3D "management game" interface on top of a strict, tax-compliant core.
Owner: mimocode778 (GitHub repo `mimocode778/-Restaurant-Saasv0`).

## Who you are working with

- The project owner is **not a developer**. Explain every step in plain English, as if
  for the first time, and define any technical word you use.
- Give **exact commands** to type in **Git Bash on Windows** (paths like `/d/dwnlds/...`,
  project folder `~/restaurant-saas`). Say what the output should look like when it worked.
- Make **targeted changes**, not rewrites. Explain what changed and why, briefly.
- Be honest about limits: say clearly when something is not done, not verified, or unsafe.
  Never present the product as "secure" or "ready to sell" before it is (see SECURITY.md).
- Screens are in **French**. Code, comments, commit messages and docs are in **English**.

## Read first

- `docs/ONBOARDING.md` — status, architecture, file map, rules, roadmap.
- `SECURITY.md` — what protects accounts, go-live checklist.
- `CONTRIBUTING.md` — workflow (branches, Pull Requests, checks).
- `README.md` — install, run, API overview.

## Stack

pnpm 12 workspace · TypeScript 6 · **API** NestJS 12 + `pg` + zod 4 + helmet (`apps/api`) ·
**DB** PostgreSQL 17 in Docker (port 15432), SQL migrations · **Web** React 19 + Vite 8,
Three.js / React Three Fiber for the 3D room (`apps/web`) · **Shared** money + VAT helpers
(`packages/shared`) · Tests: Vitest 4 + Supertest; Playwright used for browser checks.

## Commands

```bash
pnpm install
docker compose up -d                 # database
pnpm db:migrate                      # apply new migrations
pnpm test                            # shared + API unit/DB tests
pnpm test:e2e                        # full HTTP tests on a temporary database
pnpm audit                           # known library vulnerabilities
pnpm dev:api                         # API on http://localhost:3000
pnpm dev:web                         # website on http://localhost:5173 (proxies /api)
pnpm create-owner --restaurant "X" --name "Y" --email z@example.tn
(cd apps/api && pnpm lint) ; (cd apps/web && pnpm lint)
```

Every change must leave `pnpm test`, `pnpm test:e2e`, `pnpm audit` and both lints green.

## Rules that must never be broken

1. **Money = whole millimes** (integers; 1 TND = 1000). VAT rates in basis points
   (19 % = 1900). Use `packages/shared` (`assertMillimes`, `splitTtc`, `parseTnd`, `format`).
2. **The restaurant comes from the login, never from the request.** All data access goes
   through `DbService.withRestaurant(user.restaurantId, ...)` (or `withoutRestaurant` for
   login only). Row-level security in the database enforces it a second time.
3. **Append-only tables are never edited or deleted**: `sales_events`, `stock_movements`,
   `menu_item_prices`, `auth_events`. Corrections are new rows. A void/discount/refund
   points to its sale (`refers_to`) and can never exceed it (enforced by trigger).
4. **Server sets time and author**: sales typed at the till get `now()` and `recorded_by`
   from the login; the client cannot send them.
5. **Closed by default**: every route needs a login unless marked `@Public()`; use
   `@Roles(...)` for owner/manager-only actions. Waiters cannot take money back.
6. **Strict input validation** with zod `strictObject` (unknown fields refused).
7. **Never edit an applied migration** — add the next numbered file in
   `apps/api/db/migrations/`. New tables need RLS (`enable` + `force` + `tenant_isolation`
   policy) and minimal grants to `app_runtime`.
8. **Secrets** (password/PIN hashes, sessions, tablets, rate limits, two-step) live in
   tables `app_runtime` cannot read; reach them only via `auth_*` security-definer functions.
9. **No secrets in Git**: no real passwords, keys or customer data.
10. **Tests with every change**, including at least one test that tries the forbidden case
    (other restaurant, wrong role, bad input).
11. Pin new dependencies to existing, released versions; keep `pnpm audit` clean.

## Code layout (API)

Each feature folder in `apps/api/src/<feature>/`: `*.controller.ts` (routes + zod checks)
→ `*.service.ts` (one transaction per action) → `*.repository.ts` (SQL with `$1`
placeholders) → rules in the migrations. Imports inside `.ts` files end in `.js` (ESM).
Scripts in `apps/api/scripts/*.mjs` run directly with Node (no build).

## Context: the till and homologation

Since 1 July 2026, Tunisian restaurants run by companies must use a cash register system
approved by the Ministry of Finance (government decree 2019-1126, order of 14 October 2025):
fiscal module, permanent link to the Ministry platform, defined ticket contents (number,
fiscal module ID, lines before tax, VAT, payment, QR code), daily reports, no editing of
recorded operations. The owner chose to **become an approved supplier**; the specification
comes from https://homologation.nacef.tn. **Do not build ticket/fiscal features before the
official *Cahier des charges* is in the repository.** The 3D layer only displays data or asks
the till core to act; it never records sales itself.

## Delivering work to the owner

- Prefer working on a branch and opening a Pull Request when you have repository access.
- Otherwise deliver a Git bundle (`git bundle create <name>.bundle <base>..master`) and give
  the exact `git pull /d/dwnlds/<name>.bundle master` + `pnpm db:migrate` + test commands.
- End commit messages with the Co-Authored-By line required by the environment.
