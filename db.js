// db.js — dual-backend data layer.
//
// SQLite (better-sqlite3) when DATABASE_URL is unset — the local-dev default.
// Postgres (pg) when DATABASE_URL is set — production (Render + Neon).
//
// Every helper is async and returns IDENTICAL shapes on both backends:
//   - timestamps come back as 'YYYY-MM-DD HH:MM:SS' (UTC) strings
//   - ids / amounts / counts come back as JS numbers
//
// Test seam: db.__setPgPool(poolLike) forces the pg backend with any
// { query(text, params) } implementation (e.g. PGlite) — no DATABASE_URL needed.

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// backend selection
// ---------------------------------------------------------------------------

let injectedPgPool = null; // test seam
function __setPgPool(poolLike) {
  injectedPgPool = poolLike;
}
function isPg() {
  return !!(injectedPgPool || process.env.DATABASE_URL);
}

// ---------------------------------------------------------------------------
// schema (per-backend DDL)
// ---------------------------------------------------------------------------

const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  paypal_client_id TEXT,
  paypal_secret TEXT,
  paypal_mode TEXT DEFAULT 'sandbox',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fund (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  name TEXT NOT NULL,
  goal_cents INTEGER NOT NULL,
  num_contributors INTEGER NOT NULL,
  monthly_cents INTEGER NOT NULL,
  due_day INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  avatar_path TEXT,
  avatar_data BLOB,
  avatar_mime TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  paypal_order_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'confirmed',
  source TEXT NOT NULL DEFAULT 'paypal',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pending_orders (
  order_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'info',
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Late-added columns, for databases created before avatars moved into the DB.
const MIGRATIONS_SQLITE = [
  'ALTER TABLE users ADD COLUMN avatar_data BLOB',
  'ALTER TABLE users ADD COLUMN avatar_mime TEXT',
];

const SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  paypal_client_id TEXT,
  paypal_secret TEXT,
  paypal_mode TEXT DEFAULT 'sandbox',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fund (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  goal_cents INTEGER NOT NULL,
  num_contributors INTEGER NOT NULL,
  monthly_cents INTEGER NOT NULL,
  due_day INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  avatar_path TEXT,
  avatar_data BYTEA,
  avatar_mime TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  paypal_order_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'confirmed',
  source TEXT NOT NULL DEFAULT 'paypal',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pending_orders (
  order_id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'info',
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const MIGRATIONS_PG = [
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data BYTEA',
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime TEXT',
];

// ---------------------------------------------------------------------------
// sqlite backend (sync driver, wrapped in async helpers)
// ---------------------------------------------------------------------------

let sdb = null;
function sqlite() {
  if (!sdb) {
    const Database = require('better-sqlite3');
    const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'fund.db');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    sdb = new Database(DB_PATH);
    sdb.pragma('journal_mode = WAL');
    sdb.pragma('foreign_keys = ON');
    sdb.exec(SCHEMA_SQLITE);
    for (const sql of MIGRATIONS_SQLITE) {
      try { sdb.exec(sql); } catch (e) { /* column already there */ }
    }
  }
  return sdb;
}
const sget = (sql, ...p) => sqlite().prepare(sql).get(...p);
const sall = (sql, ...p) => sqlite().prepare(sql).all(...p);
const srun = (sql, ...p) => sqlite().prepare(sql).run(...p);

// ---------------------------------------------------------------------------
// postgres backend
// ---------------------------------------------------------------------------

// node-pg returns int8/numeric as strings by default — parse them as numbers.
try {
  const { types } = require('pg');
  types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
  types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
} catch (e) { /* pg not installed — sqlite-only mode */ }

let pgPool = null;
let pgSchemaDone = false;

function getPool() {
  if (injectedPgPool) return injectedPgPool;
  if (!pgPool && process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    });
    pgPool.on('error', (err) => console.error('[pg] pool error:', err.message));
  }
  return pgPool;
}

async function ensurePgSchema(pool) {
  // Split into single statements: multi-command strings fail in prepared
  // statements on some drivers (and are cleaner anyway).
  const stmts = SCHEMA_PG.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const sql of stmts) {
    await pool.query(sql);
  }
  for (const sql of MIGRATIONS_PG) {
    await pool.query(sql);
  }
}

async function pgReady() {
  const pool = getPool();
  if (!pool) throw new Error('Postgres backend selected but no pool available');
  if (!pgSchemaDone) {
    await ensurePgSchema(pool);
    pgSchemaDone = true;
  }
  return pool;
}

function fmtUtc(d) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

// Normalize one pg row: timestamps -> 'YYYY-MM-DD HH:MM:SS' UTC strings,
// matching exactly what the sqlite backend returns.
function normPgRow(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v instanceof Date) {
      out[k] = fmtUtc(v);
    } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const d = new Date(v);
      out[k] = isNaN(d.getTime()) ? v : fmtUtc(d);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function pq(text, params = []) {
  const pool = await pgReady();
  const res = await pool.query(text, params);
  return (res.rows || []).map(normPgRow);
}

// Run fn inside a transaction. Uses a dedicated client when the pool supports
// it (real pg); falls back to sequential queries for single-connection pools.
async function pgTx(fn) {
  const pool = await pgReady();
  if (typeof pool.connect === 'function') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn({ query: (t, p) => client.query(t, p) });
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  }
  return fn({ query: (t, p) => pool.query(t, p) });
}

// ---------------------------------------------------------------------------
// helpers — async, identical shapes on both backends
// ---------------------------------------------------------------------------

function mapUser(r) {
  return r ? { ...r, id: Number(r.id) } : null;
}
function mapFund(r) {
  if (!r) return null;
  return {
    ...r,
    id: Number(r.id),
    goal_cents: Number(r.goal_cents),
    num_contributors: Number(r.num_contributors),
    monthly_cents: Number(r.monthly_cents),
    due_day: Number(r.due_day),
  };
}

async function getAdmin() {
  if (isPg()) return (await pq('SELECT * FROM admins WHERE id = 1'))[0] || null;
  return sget('SELECT * FROM admins WHERE id = 1') || null;
}

async function getFund() {
  if (isPg()) return mapFund((await pq('SELECT * FROM fund WHERE id = 1'))[0]);
  return mapFund(sget('SELECT * FROM fund WHERE id = 1'));
}

async function getUser(id) {
  if (isPg()) return mapUser((await pq('SELECT * FROM users WHERE id = $1', [id]))[0]);
  return mapUser(sget('SELECT * FROM users WHERE id = ?', id));
}

async function getUserByEmail(email) {
  if (isPg()) return mapUser((await pq('SELECT * FROM users WHERE email = $1', [email]))[0]);
  return mapUser(sget('SELECT * FROM users WHERE email = ?', email));
}

async function getAdminByEmail(email) {
  if (isPg()) return (await pq('SELECT * FROM admins WHERE email = $1', [email]))[0] || null;
  return sget('SELECT * FROM admins WHERE email = ?', email) || null;
}

// Claim the single admin seat. Returns true when this call claimed it,
// false when the seat was already taken. Atomic on both backends:
// the PK on id=1 plus INSERT..DO NOTHING / INSERT OR IGNORE makes a
// concurrent double-claim impossible to corrupt.
async function claimAdmin({ name, email, phone, passwordHash }) {
  if (isPg()) {
    const rows = await pq(
      `INSERT INTO admins (id, name, email, phone, password_hash)
       VALUES (1, $1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [name, email, phone || null, passwordHash]
    );
    return rows.length === 1;
  }
  const info = srun(
    'INSERT OR IGNORE INTO admins (id, name, email, phone, password_hash) VALUES (1, ?, ?, ?, ?)',
    name, email, phone || null, passwordHash
  );
  return info.changes === 1;
}

async function setupFund({ name, goalCents, numContributors, monthlyCents, dueDay, paypalClientId, paypalSecret, paypalMode }) {
  if (isPg()) {
    await pgTx(async (c) => {
      await c.query(
        `INSERT INTO fund (id, name, goal_cents, num_contributors, monthly_cents, due_day)
         VALUES (1, $1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           goal_cents = EXCLUDED.goal_cents,
           num_contributors = EXCLUDED.num_contributors,
           monthly_cents = EXCLUDED.monthly_cents,
           due_day = EXCLUDED.due_day`,
        [name, goalCents, numContributors, monthlyCents, dueDay]
      );
      await c.query(
        'UPDATE admins SET paypal_client_id = $1, paypal_secret = $2, paypal_mode = $3 WHERE id = 1',
        [paypalClientId || null, paypalSecret || null, paypalMode]
      );
    });
    return;
  }
  sqlite().transaction(() => {
    srun(
      `INSERT INTO fund (id, name, goal_cents, num_contributors, monthly_cents, due_day)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, goal_cents=excluded.goal_cents,
         num_contributors=excluded.num_contributors, monthly_cents=excluded.monthly_cents, due_day=excluded.due_day`,
      name, goalCents, numContributors, monthlyCents, dueDay
    );
    srun(
      'UPDATE admins SET paypal_client_id = ?, paypal_secret = ?, paypal_mode = ? WHERE id = 1',
      paypalClientId || null, paypalSecret || null, paypalMode
    );
  })();
}

const EMAIL_TAKEN = 'EMAIL_TAKEN';

async function registerUser({ name, email, phone, passwordHash }) {
  const existing = await getUserByEmail(email);
  if (existing) {
    const err = new Error('Email already registered');
    err.code = EMAIL_TAKEN;
    throw err;
  }
  try {
    if (isPg()) {
      const rows = await pq(
        'INSERT INTO users (name, email, phone, password_hash) VALUES ($1, $2, $3, $4) RETURNING *',
        [name, email, phone || null, passwordHash]
      );
      return mapUser(rows[0]);
    }
    const info = srun(
      'INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)',
      name, email, phone || null, passwordHash
    );
    return mapUser(sget('SELECT * FROM users WHERE id = ?', info.lastInsertRowid));
  } catch (err) {
    if (err.code === EMAIL_TAKEN) throw err;
    if (err.code === '23505' || err.code === 'SQLITE_CONSTRAINT') {
      const e = new Error('Email already registered');
      e.code = EMAIL_TAKEN;
      throw e;
    }
    throw err;
  }
}

// Avatars live IN the database (BYTEA/BLOB + mime). Nothing touches the
// local filesystem, so this is safe on hosts with ephemeral disks.
async function setAvatar(userId, { data, mime, path }) {
  if (isPg()) {
    await pq('UPDATE users SET avatar_data = $1, avatar_mime = $2, avatar_path = $3 WHERE id = $4',
      [data, mime, path, userId]);
    return;
  }
  srun('UPDATE users SET avatar_data = ?, avatar_mime = ?, avatar_path = ? WHERE id = ?',
    data, mime, path, userId);
}

async function getAvatarByPath(urlPath) {
  const row = isPg()
    ? (await pq('SELECT avatar_data, avatar_mime FROM users WHERE avatar_path = $1', [urlPath]))[0]
    : sget('SELECT avatar_data, avatar_mime FROM users WHERE avatar_path = ?', urlPath);
  if (!row || !row.avatar_data) return null;
  return { data: Buffer.from(row.avatar_data), mime: row.avatar_mime || 'image/png' };
}

async function createPendingOrder(orderId, userId, amountCents) {
  if (isPg()) {
    await pq('INSERT INTO pending_orders (order_id, user_id, amount_cents) VALUES ($1, $2, $3)',
      [orderId, userId, amountCents]);
    return;
  }
  srun('INSERT INTO pending_orders (order_id, user_id, amount_cents) VALUES (?, ?, ?)',
    orderId, userId, amountCents);
}

async function getPendingOrder(orderId) {
  const row = isPg()
    ? (await pq('SELECT * FROM pending_orders WHERE order_id = $1', [orderId]))[0]
    : sget('SELECT * FROM pending_orders WHERE order_id = ?', orderId);
  if (!row) return null;
  return { ...row, user_id: Number(row.user_id), amount_cents: Number(row.amount_cents) };
}

async function deletePendingOrder(orderId) {
  if (isPg()) {
    await pq('DELETE FROM pending_orders WHERE order_id = $1', [orderId]);
    return;
  }
  srun('DELETE FROM pending_orders WHERE order_id = ?', orderId);
}

// Record a confirmed payment. Returns true when this call inserted the row,
// false when the order was already recorded (idempotent — the UNIQUE
// constraint on paypal_order_id makes double-processing safe).
async function recordPayment({ userId, amountCents, orderId, status = 'confirmed', source = 'paypal' }) {
  if (isPg()) {
    const pool = await pgReady();
    const res = await pool.query(
      `INSERT INTO payments (user_id, amount_cents, paypal_order_id, status, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (paypal_order_id) DO NOTHING
       RETURNING id`,
      [userId, amountCents, orderId, status, source]
    );
    return res.rowCount === 1;
  }
  const info = srun(
    'INSERT OR IGNORE INTO payments (user_id, amount_cents, paypal_order_id, status, source) VALUES (?, ?, ?, ?, ?)',
    userId, amountCents, orderId, status, source
  );
  return info.changes === 1;
}

async function sumPaymentsByUser(userId) {
  const row = isPg()
    ? (await pq("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments WHERE user_id = $1 AND status = 'confirmed'", [userId]))[0]
    : sget("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments WHERE user_id = ? AND status = 'confirmed'", userId);
  return Number(row.total);
}

async function totalConfirmedCents() {
  const row = isPg()
    ? (await pq("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments WHERE status = 'confirmed'"))[0]
    : sget("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments WHERE status = 'confirmed'");
  return Number(row.total);
}

async function confirmedPaymentCount() {
  const row = isPg()
    ? (await pq("SELECT COUNT(*) AS c FROM payments WHERE status = 'confirmed'"))[0]
    : sget("SELECT COUNT(*) AS c FROM payments WHERE status = 'confirmed'");
  return Number(row.c);
}

async function confirmedPaymentsByUser(userId) {
  const rows = isPg()
    ? await pq(
        "SELECT amount_cents, created_at FROM payments WHERE user_id = $1 AND status = 'confirmed' ORDER BY created_at ASC",
        [userId]
      )
    : sall(
        "SELECT amount_cents, created_at FROM payments WHERE user_id = ? AND status = 'confirmed' ORDER BY created_at ASC",
        userId
      );
  return rows.map((r) => ({ amount_cents: Number(r.amount_cents), created_at: r.created_at }));
}

// Month filtering happens in JS on the normalized 'YYYY-MM-DD …' strings,
// so no per-dialect date functions are needed.
async function confirmedPaymentsByUserInMonth(userId, yearMonth) {
  const all = await confirmedPaymentsByUser(userId);
  return all.filter((p) => String(p.created_at).slice(0, 7) === yearMonth);
}

async function allUsers() {
  const rows = isPg()
    ? await pq('SELECT * FROM users ORDER BY created_at ASC, id ASC')
    : sall('SELECT * FROM users ORDER BY created_at ASC, id ASC');
  return rows.map(mapUser);
}

async function addNotification(kind, text) {
  if (isPg()) {
    await pq('INSERT INTO notifications (kind, text) VALUES ($1, $2)', [kind || 'info', text]);
    return;
  }
  srun('INSERT INTO notifications (kind, text) VALUES (?, ?)', kind || 'info', text);
}

async function recentNotifications(limit = 50) {
  const rows = isPg()
    ? await pq('SELECT id, kind, text, created_at AS "createdAt" FROM notifications ORDER BY id DESC LIMIT $1', [limit])
    : sall('SELECT id, kind, text, created_at AS createdAt FROM notifications ORDER BY id DESC LIMIT ?', limit);
  return rows.map((r) => ({ id: Number(r.id), kind: r.kind, text: r.text, createdAt: r.createdAt }));
}

async function recentConfirmedPayments(limit = 50) {
  const rows = isPg()
    ? await pq(
        `SELECT p.id, p.amount_cents AS "amountCents", p.created_at AS "createdAt",
                p.paypal_order_id AS "paypalOrderId",
                u.name AS "userName", u.avatar_path AS "avatarPath"
         FROM payments p JOIN users u ON u.id = p.user_id
         WHERE p.status = 'confirmed'
         ORDER BY p.id DESC LIMIT $1`,
        [limit]
      )
    : sall(
        `SELECT p.id, p.amount_cents AS amountCents, p.created_at AS createdAt,
                p.paypal_order_id AS paypalOrderId,
                u.name AS userName, u.avatar_path AS avatarPath
         FROM payments p JOIN users u ON u.id = p.user_id
         WHERE p.status = 'confirmed'
         ORDER BY p.id DESC LIMIT ?`,
        limit
      );
  return rows.map((r) => ({
    id: Number(r.id),
    amountCents: Number(r.amountCents),
    createdAt: r.createdAt,
    paypalOrderId: r.paypalOrderId,
    userName: r.userName,
    avatarPath: r.avatarPath || null,
  }));
}

module.exports = {
  isPg,
  getPool,
  __setPgPool,
  EMAIL_TAKEN,
  getAdmin,
  getFund,
  getUser,
  getUserByEmail,
  getAdminByEmail,
  claimAdmin,
  setupFund,
  registerUser,
  setAvatar,
  getAvatarByPath,
  createPendingOrder,
  getPendingOrder,
  deletePendingOrder,
  recordPayment,
  sumPaymentsByUser,
  totalConfirmedCents,
  confirmedPaymentCount,
  confirmedPaymentsByUser,
  confirmedPaymentsByUserInMonth,
  allUsers,
  addNotification,
  recentNotifications,
  recentConfirmedPayments,
};
