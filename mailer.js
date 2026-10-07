// mailer.js — admin notifications: always logged + persisted; emailed when SMTP is configured.
// Never throws.
const nodemailer = require('nodemailer');

let cachedHelpers = null;
function helpers() {
  if (!cachedHelpers) cachedHelpers = require('./db');
  return cachedHelpers;
}

let transporter = null;
function getTransporter() {
  const host = process.env.SMTP_HOST || '';
  if (!host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

async function notifyAdmin(subject, text, kind = 'payment') {
  const line = `[notify:${kind}] ${subject} — ${text}`;
  console.log(line);
  try {
    await helpers().addNotification(kind, `${subject}: ${text}`);
  } catch (err) {
    console.error('[mailer] failed to persist notification:', err.message);
  }
  const tx = getTransporter();
  if (!tx) return;
  let to = process.env.MAIL_FROM || process.env.SMTP_USER;
  try {
    const admin = await helpers().getAdmin();
    if (admin && admin.email) to = admin.email;
  } catch (err) {
    console.error('[mailer] failed to read admin email:', err.message);
  }
  try {
    await tx.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
    });
  } catch (err) {
    console.error('[mailer] SMTP send failed:', err.message);
  }
}

module.exports = { notifyAdmin };
