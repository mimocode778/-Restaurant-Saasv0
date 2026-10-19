# Login security

What protects the accounts, and the checklist to follow before real restaurants use the
software. Keep this file up to date when the login changes.

## What is in place

| Protection | How |
|---|---|
| Passwords and PINs | Stored as slow, salted scrypt hashes, never in clear. |
| Password rules | At least 10 characters, refused if well known (including disguised: `P@ssw0rd123`) or if it contains the email name. |
| Login tokens | 256-bit random. Only their SHA-256 fingerprint is stored. |
| Secrets in the database | Password, PIN, session, tablet, attempt-counter and two-step tables cannot be read by the API's own database account at all. |
| Restaurant isolation | The restaurant always comes from the login. The database also filters every row by restaurant (row-level security). |
| Closed by default | Every route needs a login unless explicitly marked public. |
| Guessing limits | Per network address: 30 password tries / 15 min. Per account and address: 5 wrong / 15 min. Per account from everywhere: 20 wrong / hour. PINs: 5 wrong per waiter and tablet / 15 min, 15 per waiter / hour. An attacker cannot lock an owner out from another place. |
| No account discovery | Unknown email and wrong password give the same answer, in the same time, with the same limits. |
| Two-step login | Optional for owners and managers: 6-digit code from a phone app, each code usable once, 10 one-time recovery codes. The phone-app secret is encrypted (AES-256-GCM) with a key the database never sees. |
| Sessions | End after 12 hours, or 2 hours without use (30 minutes for waiters). Logout, "log out everywhere", password change, disabling a person, unpairing a tablet: all take effect immediately. |
| Waiter PINs | Only work on a tablet paired by a manager. |
| Web app cookie | `HttpOnly` (page scripts cannot read it), `SameSite=Strict`, `Secure` in production. Requests that change something must come from an allowed website (cross-site request forgery protection). |
| Browser protections | helmet headers, strict list of allowed websites (CORS), HTTPS-only header (HSTS) in production, 100 kB request limit. |
| Login history | Every login, failure, block, logout, password/PIN/two-step change, tablet pairing and staff change, with address and browser. Append-only: even the admin cannot edit or delete it. Owners and managers see their own restaurant's history. |
| Production safety checks | The API refuses to start with development passwords, a short database password, unencrypted database traffic, a missing encryption key or a missing/`http://` website list. |
| Libraries | `pnpm audit` reports no known vulnerability (checked 19 October 2026). Run `pnpm audit` again before each release. |

## Before going live (checklist)

1. **HTTPS.** Put the API behind a reverse proxy that handles HTTPS (for example Caddy,
   nginx or your host's load balancer). Never expose port 3000 directly.
2. **Environment variables** on the server:

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | `postgresql://app_runtime:<long random password>@<host>/<db>` |
   | `DB_SSL` | `true` |
   | `AUTH_SECRET_KEY` | 32 random bytes, base64 (command below). Keep a copy in a safe place: if it is lost, everyone's two-step login must be reset. |
   | `CORS_ORIGINS` | The web app's address, e.g. `https://app.your-domain.tn` |
   | `TRUST_PROXY_HOPS` | `1` when behind one reverse proxy |

   Generate a key or a password:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
3. **Database passwords.** Change the development password of the runtime account:
   `alter role app_runtime password '<long random password>';`
   Use a different, strong password for the admin account that runs migrations. The
   API must never use the admin account.
4. **Backups** of the database, encrypted, tested by restoring them once.
5. **Turn on two-step login** for every owner account.
6. **Independent review.** Before real money and customer data go in, have a security
   specialist test the login (a "penetration test").

## Forgotten passwords

- A waiter's PIN: their manager or the owner resets it in the app.
- A manager's password or lost phone: the owner resets it in the app.
- The owner's password or lost phone: you, the service operator, run
  `pnpm reset-owner-password --email <email> [--clear-two-step]`
  **after checking the person's identity by phone**, because whoever gets the new
  password gets the whole restaurant.

A "forgot password" email link needs an email-sending service; it will be added when
one is chosen.

## Known limits

- Someone who gets the API's database password could create a session for any user.
  Keep that password secret on the server only.
- Tablet tokens are stored by the tablet's browser. If a tablet is lost or stolen,
  unpair it in the app.
- When a login is blocked, the "too many attempts" message is the same for existing and
  non-existing emails.
