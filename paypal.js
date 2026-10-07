// paypal.js — PayPal REST client using global fetch (no SDK).
// All credentials come from env vars or the admin row in the DB; never logged.

let cachedDb = null;
function dbHelpers() {
  if (!cachedDb) {
    try { cachedDb = require('./db'); } catch { cachedDb = null; }
  }
  return cachedDb;
}

// Credential source: the admin row (set via /api/admin/setup) wins, env vars are the fallback.
async function getCredentials() {
  try {
    const dbh = dbHelpers();
    const admin = dbh && (await dbh.getAdmin());
    if (admin && admin.paypal_client_id && admin.paypal_secret) {
      return {
        clientId: admin.paypal_client_id,
        secret: admin.paypal_secret,
        mode: (admin.paypal_mode || '').toLowerCase() === 'live' ? 'live' : 'sandbox',
      };
    }
  } catch (err) {
    console.warn('[paypal] could not read admin credentials from DB:', err.message);
  }
  return {
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    secret: process.env.PAYPAL_CLIENT_SECRET || '',
    mode: (process.env.PAYPAL_MODE || 'sandbox').toLowerCase(),
  };
}

async function baseUrl() {
  const { mode } = await getCredentials();
  return mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function credentialsConfigured() {
  const c = await getCredentials();
  return !!(c.clientId && c.secret);
}

let tokenCache = null; // { accessToken, expiresAt }

async function getAccessToken() {
  const url = await baseUrl();
  const { clientId, secret } = getCredentials();
  if (!clientId || !secret) {
    throw new Error('PayPal credentials not configured');
  }
  if (tokenCache && Date.now() < tokenCache.expiresAt - 30_000 && tokenCache.key === `${clientId}:${secret}`) {
    return tokenCache.accessToken;
  }
  const basic = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const res = await fetch(`${url}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PayPal token request failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    key: `${clientId}:${secret}`,
  };
  return tokenCache.accessToken;
}

async function createOrder(amountCents, userId) {
  const url = await baseUrl();
  const token = await getAccessToken();
  const value = (amountCents / 100).toFixed(2);
  const res = await fetch(`${url}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: { currency_code: 'USD', value },
          custom_id: String(userId),
        },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.id) {
    throw new Error(`PayPal createOrder failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data.id;
}

async function captureOrder(orderId) {
  const url = await baseUrl();
  const token = await getAccessToken();
  const res = await fetch(`${url}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`PayPal capture failed: ${res.status} ${JSON.stringify(data)}`);
  }
  const capture = data?.purchase_units?.[0]?.payments?.captures?.[0];
  const amountValue = capture?.amount?.value;
  return {
    status: data.status,
    captureId: capture?.id || null,
    amountCents: amountValue != null ? Math.round(parseFloat(amountValue) * 100) : null,
  };
}

// verifyWebhook — verifies a PayPal webhook signature.
// req must carry req.rawBody (Buffer) and the PayPal transmission headers.
// Fail closed: returns false when PAYPAL_WEBHOOK_ID is missing or verification fails.
async function verifyWebhook(req) {
  const url = await baseUrl();
  const webhookId = process.env.PAYPAL_WEBHOOK_ID || '';
  if (!webhookId) {
    console.warn('[paypal] PAYPAL_WEBHOOK_ID not set — rejecting webhook (fail closed)');
    return false;
  }
  const token = await getAccessToken();
  const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
  const payload = {
    transmission_id: req.get('paypal-transmission-id'),
    transmission_time: req.get('paypal-transmission-time'),
    cert_url: req.get('paypal-cert-url'),
    auth_algo: req.get('paypal-auth-algo'),
    transmission_sig: req.get('paypal-transmission-sig'),
    webhook_id: webhookId,
    request_body: JSON.parse(raw),
  };
  const res = await fetch(`${url}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.warn(`[paypal] webhook signature check HTTP ${res.status}`);
    return false;
  }
  const data = await res.json();
  return data.verification_status === 'SUCCESS';
}

module.exports = { baseUrl, getAccessToken, createOrder, captureOrder, verifyWebhook, credentialsConfigured, getCredentials };
