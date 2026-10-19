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
```

## How login works

- **Owners and managers** log in with email + password: `POST /auth/login`.
- **Waiters** use a 4 to 6 digit PIN, only on a tablet a manager has paired
  (`POST /auth/devices`). The tablet shows the names (`GET /auth/device/staff`), the
  waiter types the PIN (`POST /auth/pin-login`).
- Every answer from login contains a token. Send it with each request as
  `Authorization: Bearer <token>`. It lasts 12 hours.
- The restaurant always comes from the login, never from the request.
- 5 wrong tries in a row block the account for 15 minutes.
- Only an owner or manager can record a void, discount or refund.
- An owner adds managers and waiters; a manager adds waiters (`POST /staff`).
  Disabling someone (`POST /staff/:id/disable`) ends their sessions at once.
