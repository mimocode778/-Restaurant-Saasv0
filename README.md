# Restaurant SaaS (Tunisia)

Restaurant management software: till, stock, customers. Money is always counted in
whole millimes (1 TND = 1000 millimes) so there are no rounding errors.

## First time on a computer

```bash
pnpm install                 # download the libraries
docker compose up -d         # start the database
pnpm db:migrate              # create or update the tables
pnpm create-owner --restaurant "Chez Ali" --name "Ali Ben Salah" --email ali@example.tn
```

## Every day

```bash
pnpm dev:api                 # start the API on http://localhost:3000
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

**Read [SECURITY.md](SECURITY.md) before putting the software on a real server.**
