# Build notes — Group Fund App (Oct 7, 2026)

## What was built
`~/workspace/fund-app/` — Node.js + Express, vanilla JS frontend (no build
step). Single fund, single admin seat, PayPal Checkout payments, public
ledger/scoreboard/progress, avatar uploads, admin email notifications.

## Dual-backend storage (converted Oct 7, 2026 ~8:45 AM EDT)
- `db.js` is now a dual-backend async layer: **SQLite** (better-sqlite3) when
  `DATABASE_URL` is unset (local dev), **Postgres** (`pg`) when it is set
  (production: Render + Neon). One interface, identical row shapes on both
  (timestamps as 'YYYY-MM-DD HH:MM:SS' UTC strings, ids/amounts as numbers).
- All SQL is valid Postgres ($1 params, BIGSERIAL keys, ON CONFLICT);
  per-backend DDL where dialects differ. Month filtering done in JS on
  normalized timestamp strings — no strftime/to_char split.
- Admin seat lock is race-safe on both: atomic
  `INSERT ... ON CONFLICT DO NOTHING RETURNING` (pg) /
  `INSERT OR IGNORE` (sqlite) on the id=1 PK.
- **Avatars live in the database** (BYTEA/BLOB + mime), uploaded via
  multer memoryStorage, served from DB at the same `/uploads/...` URLs —
  frontend unchanged. Nothing touches the local filesystem, safe for
  Render's ephemeral disk.
- Sessions: Postgres-backed (`connect-pg-simple`) in production, in-memory
  locally.
- `render.yaml` Blueprint included (free web service, health check
  `/api/status`, `SESSION_SECRET` auto-generated, `DATABASE_URL` to be
  pasted from Neon). `.gitignore` covers node_modules, .env, data/,
  uploads/.
- `paypal.js` credential functions are now async (they read the admin row);
  `mailer.js` awaits the async db helpers.

## What was tested (all passing, Oct 7 ~8:50 AM EDT)
SQLite backend (HTTP, port 3000) — full flow: admin claim ok, double-claim
409, fund setup validated, contributor register 201, duplicate register 409,
demo payment $750 captured, fund totals $750/$6,000 with share $750 and
paidInFull=true, ledger row correct, scoreboard 'late' (past due day 1),
avatar upload -> served back 200 image/png from DB, admin notification
persisted. All JS passes node --check.
Postgres backend (PGlite, in-process) — identical flow at both the db-helper
level and full HTTP level: claim true / double-claim false, EMAIL_TAKEN on
duplicate, idempotent recordPayment (true then false), sums/counts as
numbers, avatar BYTEA round-trip, ledger row shape identical to SQLite,
scoreboard identical, /uploads/ 200 + 404. Timestamps normalize to the same
UTC string format as SQLite.

## What the user must still do before go-live
1. **PayPal credentials** — the fund's admin creates a PayPal Business
   account, makes an app at developer.paypal.com, and enters the Client ID +
   Secret in the admin setup screen (or env). Without them the app runs in
   clearly-labeled demo mode (no real charges).
2. **Deploy** — push this repo to GitHub, deploy via render.yaml on Render,
   paste the Neon connection string into DATABASE_URL.
3. **SMTP (optional)** — for admin email notifications; without it,
   notifications are logged + shown on the admin dashboard.

## Test data
All QA test data wiped after testing (data/fund.db* deleted; PGlite data was
in-memory only). The repo ships a clean slate: no admin claimed, no fund
configured.
