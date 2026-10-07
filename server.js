// server.js — Express API for the group-fund app.
//
// Storage backends: SQLite locally (default), Postgres when DATABASE_URL is
// set (production). Avatars live IN the database — nothing here relies on the
// local filesystem, so ephemeral disks (Render free tier) are safe.
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const multer = require('multer');

const db = require('./db');
const paypal = require('./paypal');
const { notifyAdmin } = require('./mailer');

const PROJECT_DIR = __dirname;
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const app = express();

// Webhook route must see the RAW body for signature verification, so it is
// registered BEFORE the JSON parser, using express.raw().
app.post(
  '/api/webhooks/paypal',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      const ok = await paypal.verifyWebhook(req);
      if (!ok) return res.status(401).json({ error: 'Webhook signature verification failed' });

      let event;
      try {
        event = JSON.parse(req.rawBody.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Invalid JSON body' });
      }

      if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
        const resource = event.resource || {};
        const orderId = resource.supplementary_data?.related_ids?.order_id || null;
        const amountCents = resource.amount?.value != null ? Math.round(parseFloat(resource.amount.value) * 100) : null;
        const userId = parseInt(resource.custom_id, 10);
        if (orderId && amountCents != null && Number.isFinite(userId)) {
          const inserted = await db.recordPayment({
            userId,
            amountCents,
            orderId,
            status: 'confirmed',
            source: 'paypal',
          });
          if (inserted) {
            const user = await db.getUser(userId);
            const total = await db.sumPaymentsByUser(userId);
            await notifyAdmin(
              'Payment received',
              `${user ? user.name : 'User #' + userId} paid $${(amountCents / 100).toFixed(2)} — new total $${(total / 100).toFixed(2)}`
            );
            await db.deletePendingOrder(orderId);
          }
        }
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[webhook] error:', err.message);
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Sessions: Postgres-backed in production (survives restarts/deploys),
// in-memory locally.
let sessionStore;
if (process.env.DATABASE_URL) {
  const PgSession = require('connect-pg-simple')(session);
  sessionStore = new PgSession({
    pool: db.getPool(),
    tableName: 'session',
    createTableIfMissing: true,
  });
}

app.use(
  session({
    name: 'fund.sid',
    secret: process.env.SESSION_SECRET || 'dev-only-change-me',
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    },
  })
);

// ---- helpers ---------------------------------------------------------------

async function isDemoMode() {
  if ((process.env.DEMO_MODE || '').toLowerCase() === 'true') return true;
  return !(await paypal.credentialsConfigured());
}

function avatarUrlFor(user) {
  return user && user.avatar_path ? user.avatar_path : null;
}

function sessionInfo(req) {
  if (!req.session || !req.session.type) return null;
  return { type: req.session.type, id: req.session.uid, name: req.session.name, avatarUrl: req.session.avatarUrl || null };
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.type === 'admin') return next();
  return res.status(401).json({ error: 'Admin login required' });
}

function requireUser(req, res, next) {
  if (req.session && req.session.type === 'user') return next();
  return res.status(401).json({ error: 'Login required' });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function money(cents) {
  return (cents / 100).toFixed(2);
}

// ---- avatar upload -----------------------------------------------------------
// Avatars are stored IN the database (BYTEA/BLOB + mime), never on disk.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Invalid file type'), ok);
  },
});

// ---- API ---------------------------------------------------------------------

app.get('/api/status', async (req, res) => {
  const [admin, fund] = await Promise.all([db.getAdmin(), db.getFund()]);
  res.json({
    adminExists: !!admin,
    fundConfigured: !!fund,
    session: sessionInfo(req),
  });
});

// --- admin claim: one row ever; atomic INSERT makes a race impossible to corrupt.
app.post('/api/admin/claim', async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const hash = await bcrypt.hash(String(password), 10);
  try {
    const claimed = await db.claimAdmin({
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      phone: phone ? String(phone).trim() : null,
      passwordHash: hash,
    });
    if (!claimed) return res.status(409).json({ error: 'Admin seat already claimed' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[admin/claim]', err.message);
    return res.status(500).json({ error: 'Claim failed' });
  }
});

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const admin = await db.getAdminByEmail(String(email).toLowerCase().trim());
  if (!admin) return res.status(401).json({ error: 'Invalid email or password' });
  const ok = await bcrypt.compare(String(password), admin.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
  req.session.type = 'admin';
  req.session.uid = admin.id;
  req.session.name = admin.name;
  req.session.avatarUrl = null;
  return res.json({ ok: true });
});

app.post('/api/admin/setup', requireAdmin, async (req, res) => {
  const { fundName, goalDollars, numContributors, monthlyDollars, dueDay, paypalClientId, paypalSecret, paypalMode } = req.body || {};
  if (!fundName || String(fundName).trim().length === 0) return res.status(400).json({ error: 'fundName is required' });

  const goalCents = Math.round(Number(goalDollars) * 100);
  const n = parseInt(numContributors, 10);
  const monthlyCents = Math.round(Number(monthlyDollars) * 100);
  const d = parseInt(dueDay, 10);
  const mode = paypalMode === 'live' ? 'live' : 'sandbox';

  if (!Number.isFinite(goalCents) || goalCents <= 0) return res.status(400).json({ error: 'goalDollars must be > 0' });
  if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'numContributors must be an integer ≥ 1' });
  if (!Number.isFinite(monthlyCents) || monthlyCents < 0) return res.status(400).json({ error: 'monthlyDollars must be ≥ 0' });
  if (!Number.isInteger(d) || d < 1 || d > 28) return res.status(400).json({ error: 'dueDay must be 1–28' });

  try {
    await db.setupFund({
      name: String(fundName).trim(),
      goalCents,
      numContributors: n,
      monthlyCents,
      dueDay: d,
      paypalClientId: paypalClientId ? String(paypalClientId).trim() : null,
      paypalSecret: paypalSecret ? String(paypalSecret).trim() : null,
      paypalMode: mode,
    });
  } catch (err) {
    console.error('[admin/setup]', err.message);
    return res.status(500).json({ error: 'Setup failed' });
  }
  return res.json({ ok: true });
});

app.get('/api/admin/notifications', requireAdmin, async (req, res) => {
  res.json({ notifications: await db.recentNotifications(50) });
});

// --- users --------------------------------------------------------------------

app.post('/api/users/register', async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const normalizedEmail = String(email).toLowerCase().trim();
  const existing = await db.getUserByEmail(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = await bcrypt.hash(String(password), 10);
  try {
    const user = await db.registerUser({
      name: String(name).trim(),
      email: normalizedEmail,
      phone: phone ? String(phone).trim() : null,
      passwordHash: hash,
    });
    req.session.type = 'user';
    req.session.uid = user.id;
    req.session.name = user.name;
    req.session.avatarUrl = avatarUrlFor(user);
    return res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === db.EMAIL_TAKEN) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    console.error('[users/register]', err.message);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/users/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const user = await db.getUserByEmail(String(email).toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
  req.session.type = 'user';
  req.session.uid = user.id;
  req.session.name = user.name;
  req.session.avatarUrl = avatarUrlFor(user);
  return res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('fund.sid');
    res.json({ ok: true });
  });
});

app.post('/api/users/avatar', requireUser, (req, res) => {
  upload.single('avatar')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Invalid file' });
    if (!req.file) return res.status(400).json({ error: 'No avatar file provided (field name: avatar)' });
    try {
      const ext = (req.file.mimetype.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
      const avatarPath = `/uploads/${req.session.uid}-${Date.now()}.${ext}`;
      await db.setAvatar(req.session.uid, {
        data: req.file.buffer,
        mime: req.file.mimetype,
        path: avatarPath,
      });
      req.session.avatarUrl = avatarPath;
      return res.json({ avatarUrl: avatarPath });
    } catch (e) {
      console.error('[users/avatar]', e.message);
      return res.status(500).json({ error: 'Avatar upload failed' });
    }
  });
});

// Avatars are served from the database at the same /uploads/ URLs the
// frontend already uses — no frontend change needed.
app.get('/uploads/:file', async (req, res) => {
  try {
    const avatar = await db.getAvatarByPath('/uploads/' + req.params.file);
    if (!avatar) return res.status(404).send('Not found');
    res.set('Content-Type', avatar.mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(avatar.data);
  } catch (err) {
    console.error('[uploads]', err.message);
    return res.status(500).send('Error');
  }
});

// --- fund / ledger / scoreboard ------------------------------------------------

app.get('/api/fund', async (req, res) => {
  const fund = await db.getFund();
  const users = await db.allUsers();
  const shareCents = fund ? Math.round(fund.goal_cents / fund.num_contributors) : 0;
  const contributors = [];
  for (const u of users) {
    const totalCents = await db.sumPaymentsByUser(u.id);
    contributors.push({
      id: u.id,
      name: u.name,
      avatarUrl: avatarUrlFor(u),
      totalCents,
      shareCents,
      paidInFull: totalCents >= shareCents,
    });
  }
  res.json({
    fund: fund
      ? {
          name: fund.name,
          goalCents: fund.goal_cents,
          numContributors: fund.num_contributors,
          monthlyCents: fund.monthly_cents,
          dueDay: fund.due_day,
          createdAt: fund.created_at,
        }
      : null,
    totalCents: await db.totalConfirmedCents(),
    paymentCount: await db.confirmedPaymentCount(),
    demoMode: await isDemoMode(),
    contributors,
  });
});

app.get('/api/ledger', async (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isInteger(limit) || limit < 1) limit = 50;
  limit = Math.min(limit, 200);
  const payments = (await db.recentConfirmedPayments(limit)).map((p) => ({
    id: p.id,
    userName: p.userName,
    avatarUrl: p.avatarPath || null,
    amountCents: p.amountCents,
    createdAt: p.createdAt,
    paypalOrderId: p.paypalOrderId,
  }));
  res.json({ payments });
});

app.get('/api/scoreboard', async (req, res) => {
  const fund = await db.getFund();
  if (!fund) return res.json({ months: [], rows: [] });

  const months = [];
  const start = String(fund.created_at).slice(0, 7); // 'YYYY-MM'
  const now = new Date();
  let cursor = start;
  const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  while (cursor <= curMonth) {
    months.push(cursor);
    const [y, m] = cursor.split('-').map(Number);
    const next = new Date(Date.UTC(y, m, 1)); // m is 1-based, so month index m = next month
    cursor = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  const users = await db.allUsers();
  const rows = [];
  for (const u of users) {
    const cells = {};
    for (const ym of months) {
      if (fund.monthly_cents <= 0) {
        cells[ym] = 'paid';
        continue;
      }
      const pays = await db.confirmedPaymentsByUserInMonth(u.id, ym);
      let running = 0;
      let metOn = null;
      for (const p of pays) {
        running += p.amount_cents;
        if (running >= fund.monthly_cents) {
          metOn = p.created_at;
          break;
        }
      }
      if (!metOn) {
        cells[ym] = 'missed';
      } else {
        const day = parseInt(String(metOn).slice(8, 10), 10);
        cells[ym] = day <= fund.due_day ? 'paid' : 'late';
      }
    }
    rows.push({ userId: u.id, userName: u.name, avatarUrl: avatarUrlFor(u), cells });
  }

  res.json({ months, rows });
});

// --- payments -----------------------------------------------------------------

app.get('/api/pay/config', async (req, res) => {
  const creds = await paypal.getCredentials();
  res.json({
    demoMode: await isDemoMode(),
    paypalClientId: creds.clientId || null,
    currency: 'USD',
  });
});

app.post('/api/pay/create-order', requireUser, async (req, res) => {
  const amountCents = Math.round(Number(req.body?.amountDollars) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > 10_000_000) {
    return res.status(400).json({ error: 'amountDollars must be between $0.01 and $100,000' });
  }
  const userId = req.session.uid;

  if (await isDemoMode()) {
    // DEMO MODE: no real PayPal call. Fake order id; nothing is charged.
    const orderId = `DEMO-${Date.now()}-${userId}`;
    await db.createPendingOrder(orderId, userId, amountCents);
    return res.json({ demo: true, orderId });
  }

  try {
    const orderId = await paypal.createOrder(amountCents, userId);
    await db.createPendingOrder(orderId, userId, amountCents);
    return res.json({ orderId });
  } catch (err) {
    console.error('[pay/create-order]', err.message);
    return res.status(502).json({ error: 'Failed to create PayPal order' });
  }
});

app.post('/api/pay/capture-order', requireUser, async (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId || typeof orderId !== 'string') return res.status(400).json({ error: 'orderId is required' });
  const userId = req.session.uid;

  const pending = await db.getPendingOrder(orderId);
  if (!pending) return res.status(404).json({ error: 'Order not found' });
  if (pending.user_id !== userId) return res.status(403).json({ error: 'Order does not belong to this user' });

  const user = await db.getUser(userId);
  const userName = user ? user.name : `User #${userId}`;

  if (orderId.startsWith('DEMO-')) {
    // DEMO MODE: no real money moves. Record a confirmed payment marked source='demo'.
    await db.recordPayment({ userId, amountCents: pending.amount_cents, orderId, status: 'confirmed', source: 'demo' });
    await db.deletePendingOrder(orderId);
    const total = await db.sumPaymentsByUser(userId);
    await notifyAdmin(
      'Demo payment',
      `${userName} paid $${money(pending.amount_cents)} — new total $${money(total)} (demo, no real charge)`
    );
    return res.json({ ok: true, amountCents: pending.amount_cents });
  }

  try {
    const result = await paypal.captureOrder(orderId);
    if (result.status !== 'COMPLETED') {
      return res.status(402).json({ error: 'Payment not completed' });
    }
    const amountCents = result.amountCents ?? pending.amount_cents;
    const inserted = await db.recordPayment({ userId, amountCents, orderId, status: 'confirmed', source: 'paypal' });
    // Idempotent: paypal_order_id UNIQUE — a conflict means the webhook already recorded it.
    await db.deletePendingOrder(orderId);
    const total = await db.sumPaymentsByUser(userId);
    if (inserted) {
      await notifyAdmin(
        'Payment received',
        `${userName} paid $${money(amountCents)} — new total $${money(total)}`
      );
    }
    return res.json({ ok: true, amountCents });
  } catch (err) {
    console.error('[pay/capture-order]', err.message);
    return res.status(502).json({ error: 'Capture failed' });
  }
});

// ---- static -------------------------------------------------------------------

app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ---- global error handler (a bad request must never crash the server) ---------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled]', err && err.message ? err.message : err);
  if (res.headersSent) return;
  const status = err && err.status ? err.status : 500;
  res.status(status).json({ error: 'Something went wrong' });
});

// ---- boot ---------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, async () => {
  console.log(`[fund-app] listening on port ${PORT} (pg=${db.isPg()}, demoMode=${await isDemoMode()})`);
});
