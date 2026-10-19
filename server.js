/**
 * CertiForge - Backend Server
 * Express + Nodemailer
 *
 * Endpoints:
 *   GET  /api/health         -> simple health check
 *   POST /api/test-smtp      -> verify SMTP credentials
 *   POST /api/send-emails    -> send a batch of emails (each may carry multiple attachments)
 *
 * SMTP credentials are passed per-request from the UI and are never persisted on the server.
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
// Certificates are sent as base64 PNG buffers -> allow large bodies.
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a nodemailer transporter from a config object sent by the client.
 * @param {{host:string, port:number|string, user:string, pass:string, secure?:boolean}} cfg
 */
function buildTransporter(cfg) {
  if (!cfg || !cfg.host || !cfg.port || !cfg.user || !cfg.pass) {
    const err = new Error('SMTP configuration incomplete: host, port, user and pass are required.');
    err.status = 400;
    throw err;
  }
  const port = Number(cfg.port);
  const secure = typeof cfg.secure === 'boolean' ? cfg.secure : port === 465;

  return nodemailer.createTransport({
    host: String(cfg.host).trim(),
    port,
    secure,
    auth: {
      user: String(cfg.user).trim(),
      pass: String(cfg.pass)
    },
    // Reasonable timeouts so a bad host does not hang the request forever
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
    tls: {
      // Allow self-signed certs on private mail servers; set SMTP_STRICT_TLS=true to enforce
      rejectUnauthorized: process.env.SMTP_STRICT_TLS === 'true'
    }
  });
}

/**
 * Convert base64 attachments from the client to nodemailer attachment objects.
 * Accepts either raw base64 or a data-URL (data:image/png;base64,....).
 */
function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && a.content)
    .map((a, idx) => {
      let content = String(a.content);
      const commaIdx = content.indexOf('base64,');
      if (content.startsWith('data:') && commaIdx !== -1) {
        content = content.slice(commaIdx + 7);
      }
      return {
        filename: a.filename || `certificate_${idx + 1}.png`,
        content: Buffer.from(content, 'base64'),
        contentType: a.contentType || 'image/png'
      };
    });
}

/** Very small HTML escaper used for the plain-text fallback. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'CertiForge', time: new Date().toISOString() });
});

/**
 * POST /api/test-smtp
 * Body: { host, port, user, pass, secure? }
 */
app.post('/api/test-smtp', async (req, res) => {
  try {
    const transporter = buildTransporter(req.body || {});
    await transporter.verify();
    res.json({ ok: true, message: 'SMTP connection verified successfully.' });
  } catch (err) {
    res.status(err.status || 500).json({
      ok: false,
      message: err.message || 'SMTP verification failed.',
      code: err.code || null
    });
  }
});

/**
 * POST /api/send-emails
 * Body: {
 *   smtp: { host, port, user, pass, secure?, fromName? },
 *   delayMs?: number,                 // delay between messages (rate limiting)
 *   emails: [{
 *     id: string,                     // client reference id
 *     to: string,
 *     subject: string,
 *     html: string,
 *     attachments: [{ filename, content(base64), contentType }]
 *   }]
 * }
 * Response: { ok, results: [{ id, to, status: 'success'|'failed', messageId?, error? }] }
 */
app.post('/api/send-emails', async (req, res) => {
  const { smtp, emails, delayMs } = req.body || {};

  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ ok: false, message: 'No emails provided.' });
  }

  let transporter;
  try {
    transporter = buildTransporter(smtp);
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, message: err.message });
  }

  const fromName = (smtp.fromName || 'CertiForge').replace(/["<>]/g, '').trim();
  const fromAddress = `"${fromName}" <${String(smtp.user).trim()}>`;
  const delay = Math.min(Math.max(Number(delayMs) || 0, 0), 60000);

  const results = [];

  for (let i = 0; i < emails.length; i++) {
    const item = emails[i] || {};
    const to = String(item.to || '').trim();

    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      results.push({ id: item.id, to, status: 'failed', error: 'Invalid recipient address.' });
      continue;
    }

    try {
      const info = await transporter.sendMail({
        from: fromAddress,
        to,
        subject: item.subject || 'Your Certificate',
        html: item.html || '',
        text: htmlToText(item.html),
        attachments: normalizeAttachments(item.attachments)
      });
      results.push({ id: item.id, to, status: 'success', messageId: info.messageId });
    } catch (err) {
      results.push({ id: item.id, to, status: 'failed', error: err.message || 'Send failed.' });
    }

    if (delay > 0 && i < emails.length - 1) {
      await sleep(delay);
    }
  }

  const sent = results.filter((r) => r.status === 'success').length;
  res.json({ ok: true, sent, failed: results.length - sent, results });
});

// SPA fallback -> index.html
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Error handler (e.g. payload too large)
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[CertiForge] Error:', err.message);
  res.status(err.status || 500).json({ ok: false, message: err.message || 'Server error' });
});

app.listen(PORT, () => {
  console.log(`\n  CertiForge is running  ->  http://localhost:${PORT}\n`);
});
