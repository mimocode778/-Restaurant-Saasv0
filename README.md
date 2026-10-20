# Restaurant SaaS (Tunisia)

Restaurant management software: till, stock, customers. Money is always counted in
whole millimes (1 TND = 1000 millimes) so there are no rounding errors.

**New to the project? Read [docs/ONBOARDING.md](docs/ONBOARDING.md) first, then [CONTRIBUTING.md](CONTRIBUTING.md).**

## First time on a computer

```bash
pnpm install                 # download the libraries
docker compose up -d         # start the database
pnpm db:migrate              # create or update the tables
pnpm create-owner --restaurant "Chez Ali" --name "Ali Ben Salah" --email ali@example.tn
```

## Every day

Open two Git Bash windows:

```bash
pnpm dev:api                 # window 1: the API on http://localhost:3000
pnpm dev:web                 # window 2: the website on http://localhost:5173
```

Then open **http://localhost:5173** in your browser and log in.

```bash
pnpm test                    # quick tests
pnpm test:e2e                # full tests over HTTP, on a temporary database
pnpm audit                   # check the libraries for known security problems
```

## How login works

- **Owners and managers** log in with email + password: `POST /auth/login`. If two-step
  login is on, the answer asks for `twoStepCode` (6 digits from the phone app) or a
  `recoveryCode`.
- **Waiters** use a 4 to 6 digit PIN, only on a tablet a manager has paired
  (`POST /auth/devices`). The tablet shows the names (`GET /auth/device/staff`), the
  waiter types the PIN (`POST /auth/pin-login`).
- **The web app** must send `"useCookie": true`: the login is then kept in a protected
  cookie. Other clients get a token to send as `Authorization: Bearer <token>`.
- Logins last 12 hours, and end sooner when not used.
- Account: `GET /auth/me`, `POST /auth/password`, `POST /auth/logout`,
  `POST /auth/logout-everywhere`, `POST /auth/two-step/setup|confirm|disable`.
- Owners and managers: `GET /auth/events` (login history), `GET /auth/devices`,
  `POST /auth/devices/:id/revoke`, `POST /staff`, `POST /staff/:id/disable`,
  `POST /staff/:id/reset-pin`; owners also `reset-password` and `reset-two-step`.
- Only an owner or manager can record a void, discount or refund.

## Menu and prices

- Prices are entered **including VAT**, in millimes: 12,500 TND is `12500`.
- Each dish has its own VAT rate in **basis points**: 19 % is `1900`, 7 % is `700`.
  The software does not fix the rate; confirm the right one with an accountant.
- The answer always shows the price before VAT (`htMillimes`) and the VAT
  (`vatMillimes`); the two always add up exactly to the price.
- Everyone reads the menu (`GET /menu`); owners and managers change it:
  `POST /menu/categories`, `PATCH /menu/categories/:id`, `POST /menu/categories/:id/archive`,
  `POST /menu/items`, `PATCH /menu/items/:id`, `POST /menu/items/:id/price`,
  `GET /menu/items/:id/prices` (history), `POST /menu/items/:id/archive|restore`.
- Dishes are archived, never deleted, and a price change never erases the old price.

## Dining room and 3D view

- Page **Salle (3D)**: owners and managers add tables, the counter, the kitchen, plants and
  doors, then place them on the plan (seen from above) by dragging them.
- The **3D view** shows the same room: drag to turn around it, scroll or pinch to zoom,
  click a table to select it. Waiters can see it but not change it.
- API: `GET /floor`, `PUT /floor/plan`, `POST /floor/items`, `PATCH /floor/items/:id`,
  `POST /floor/items/:id/archive`. Positions are in centimetres.
- The 3D view only displays the room. It never records sales (that stays in the till core).

## Stock

- Page **Stock** (owners and managers only; waiters have no access).
- Stock works like a bank statement: every delivery, usage, waste and stocktake is a new
  line in an append-only journal; the quantity shown is the sum of the lines.
- Quantities are whole numbers in a **base unit**: grams (`g`), millilitres (`ml`) or
  pieces (`piece`). The screens show kg and L: 1.5 kg is `1500`. A product's unit never changes.
- **Pack sizes** ("Caisse de 12 x 1 L" = `12000` ml) let a delivery be typed as "2 crates".
- A delivery can carry its **price before VAT** (`costMillimes`), used for the estimated
  stock value (quantity x last price) and the cost in the report.
- A **stocktake** sends the counted quantities; the database records the difference.
- Stock may go below zero (the answer says `belowZero: true`) so a missing delivery never
  blocks the kitchen; the screen warns instead.
- API: `GET /stock/items`, `GET /stock/items/:id`, `POST /stock/items`, `PATCH /stock/items/:id`,
  `POST /stock/items/:id/archive|restore`, `POST /stock/items/:id/packs`,
  `POST /stock/items/:id/packs/:packId/archive`, `POST /stock/items/:id/movements`
  (`purchase`, `usage`, `waste` with a `reason`), `GET /stock/items/:id/movements`,
  `POST /stock/counts`, `GET /stock/report?from=2026-10-13&to=2026-10-20`.

**Read [SECURITY.md](SECURITY.md) before putting the software on a real server.**
