/**
 * Download-page feedback ("How was your conversion?").
 *
 *  POST /api/feedback   {rating 1-5, category, name?, country?, comment?, tool?, jobId?}
 *
 *  - Everything is validated here; the page's own checks are only a convenience.
 *  - The review is stored in the existing database (D1, or the local SQLite file when D1 is not configured) BEFORE any e-mail is tried.
 *    The notification e-mail is then sent in the background through the existing Gmail SMTP mailer; its outcome is saved on the row
 *    (emailed = 1) and never changes the answer given to the visitor, who is told only that the feedback was received.
 *  - Stored: rating, category, optional name, optional country code, optional comment, tool id, internal job id. Never stored: file
 *    names, file contents, e-mail addresses, IP addresses (the rate limiter keeps a hashed address in memory only).
 *  - There is no endpoint that lists reviews.
 *  - The table is created on first use with CREATE TABLE IF NOT EXISTS (local database and remote D1). Set FEEDBACK_AUTO_MIGRATE=false to disable that and
 *    run migrations/002_create_feedback.sql yourself; while the table is missing the endpoint answers 503 FEEDBACK_UNAVAILABLE.
 */
const crypto = require('crypto');
const COUNTRIES = new Set(require('./assets/countries.js'));

const CATEGORIES = {
  perfect: 'Perfect conversion', format: 'Formatting issue', missing: 'Missing content',
  slow: 'Slow conversion', download: 'Download issue', other: 'Other issue'
};
const LIMITS = { name: 60, comment: 1000, body: 8 * 1024 };
const WINDOW_MS = 10 * 60 * 1000, MAX_PER_WINDOW = 5;
const JOB_ID = /^cjob_[a-f0-9]{32}$/;
const TOOL_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

const hits = new Map();          // hashed address -> { n, reset }
const seenJobs = new Set();      // jobs that already have a review (also enforced by the unique index)
let storage = null, tableState = null;

function db() { if (storage === null) { try { storage = require('./storage'); } catch (e) { storage = false; } } return storage || null; }
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]', 'g');
const clean = (s, max) => String(s == null ? '' : s).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function validate(body) {
  const b = body && typeof body === 'object' ? body : {};
  const rating = Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: 'INVALID_RATING', message: 'Please choose a rating from 1 to 5 stars.' };
  const category = String(b.category || '');
  if (!Object.prototype.hasOwnProperty.call(CATEGORIES, category)) return { error: 'INVALID_CATEGORY', message: 'Please choose what best describes your conversion.' };
  if (typeof b.comment === 'string' && b.comment.length > LIMITS.comment * 2) return { error: 'COMMENT_TOO_LONG', message: `Please keep the comment under ${LIMITS.comment} characters.` };
  if (typeof b.name === 'string' && b.name.length > LIMITS.name * 3) return { error: 'NAME_TOO_LONG', message: `Please keep the name under ${LIMITS.name} characters.` };
  const comment = clean(b.comment, 100000);
  if (comment.length > LIMITS.comment) return { error: 'COMMENT_TOO_LONG', message: `Please keep the comment under ${LIMITS.comment} characters.` };
  const name = clean(b.name, 100000);
  if (name.length > LIMITS.name) return { error: 'NAME_TOO_LONG', message: `Please keep the name under ${LIMITS.name} characters.` };
  const country = String(b.country || '').toUpperCase();
  if (!country) return { error: 'COUNTRY_REQUIRED', message: 'Please select your country.' };
  if (!COUNTRIES.has(country)) return { error: 'INVALID_COUNTRY', message: 'Please select a country from the list.' };
  const tool = b.tool && TOOL_ID.test(String(b.tool)) ? String(b.tool) : null;
  const jobId = b.jobId && JOB_ID.test(String(b.jobId)) ? String(b.jobId) : null;
  return { data: { rating, category, name: name || null, country, comment: comment || null, tool, jobId } };
}

function limited(ip) {
  const h = crypto.createHash('sha256').update('fb|' + ip).digest('hex');
  const now = Date.now();
  let r = hits.get(h);
  if (!r || now > r.reset) { r = { n: 0, reset: now + WINDOW_MS }; hits.set(h, r); }
  if (r.n >= MAX_PER_WINDOW) return Math.ceil((r.reset - now) / 1000);
  r.n++;
  return 0;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (n > v.reset) hits.delete(k); }, 5 * 60 * 1000).unref();

async function ensureTable() {
  if (tableState === true) return true;
  const s = db();
  if (!s || !s.executeD1Query) return false;
  try {
    if (String(process.env.FEEDBACK_AUTO_MIGRATE || '').toLowerCase() !== 'false') {   // idempotent CREATE TABLE IF NOT EXISTS; FEEDBACK_AUTO_MIGRATE=false switches it off
      await s.executeD1Query(`CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        category TEXT NOT NULL, name TEXT, country TEXT, comment TEXT, tool TEXT, job_id TEXT, emailed INTEGER NOT NULL DEFAULT 0)`);
      await s.executeD1Query('CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_job ON feedback(job_id) WHERE job_id IS NOT NULL');
    }
    await s.executeD1Query('SELECT 1 FROM feedback LIMIT 1');     // fails when the migration has not been run
    tableState = true;
    return true;
  } catch (e) {
    console.error('[feedback] storage not ready:', String(e.message || e).slice(0, 160));
    return false;
  }
}

function handler(mailer) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (parseInt(req.headers['content-length'] || '0', 10) > LIMITS.body) return res.status(413).json({ error: 'TOO_LARGE', message: 'That submission is too large.' });
    const security = require('./security');
    const wait = limited(security.getClientIp(req));
    if (wait) { res.setHeader('Retry-After', String(wait)); return res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many submissions. Please try again later.' }); }
    const v = validate(req.body);
    if (v.error) return res.status(400).json({ error: v.error, message: v.message });
    const d = v.data;
    if (d.jobId && seenJobs.has(d.jobId)) return res.status(409).json({ error: 'ALREADY_SUBMITTED', message: 'Feedback for this conversion was already received. Thank you!' });
    if (!(await ensureTable())) return res.status(503).json({ error: 'FEEDBACK_UNAVAILABLE', message: 'Feedback is temporarily unavailable.' });

    const rec = { id: 'fb_' + crypto.randomBytes(12).toString('hex'), createdAt: Date.now(), ...d };
    try {
      await db().executeD1Query('INSERT INTO feedback (id, created_at, rating, category, name, country, comment, tool, job_id, emailed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
        [rec.id, rec.createdAt, d.rating, d.category, d.name, d.country, d.comment, d.tool, d.jobId]);
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e.message))) { if (d.jobId) seenJobs.add(d.jobId); return res.status(409).json({ error: 'ALREADY_SUBMITTED', message: 'Feedback for this conversion was already received. Thank you!' }); }
      console.error('[feedback] could not store a review:', String(e.message || e).slice(0, 160));
      return res.status(503).json({ error: 'FEEDBACK_UNAVAILABLE', message: 'Feedback could not be saved right now. Please try again later.' });
    }
    if (d.jobId) { seenJobs.add(d.jobId); if (seenJobs.size > 5000) seenJobs.delete(seenJobs.values().next().value); }
    // The review is saved; now try the notification (bounded wait). The answer says what really happened: nothing is reported as sent unless the provider accepted it.
    // Wait only a few seconds for the provider: the visitor must not sit on a spinner. 'sent' = accepted, 'failed' = refused, 'pending' = still trying
    // in the background (the row is marked e-mailed when it succeeds; otherwise the retry sweep picks it up).
    const attempt = mailer.sendFeedbackEmail({ ...rec, categoryLabel: CATEGORIES[d.category] }).then(async (sent) => {
      console.log(`[feedback] notification accepted by ${sent.provider} for review ${rec.id}`);
      await db().executeD1Query('UPDATE feedback SET emailed = 1 WHERE id = ?', [rec.id]).catch(() => {});
      return 'sent';
    }).catch((e) => {
      console.error(`[feedback] review ${rec.id} saved, notification NOT sent (${e && e.mailCode || 'UNKNOWN'}): ${String(e && e.message || e).replace(/re_[A-Za-z0-9_]+/g, '[key]').slice(0, 160)}`);   // emailed stays 0: the retry sweep picks it up
      return 'failed';
    });
    const notification = await Promise.race([attempt, new Promise((r) => setTimeout(() => r('pending'), 4000).unref())]);
    res.json({ success: true, saved: true, notification });
  };
}

// Reviews that were saved but not yet e-mailed (mail was misconfigured or down) are retried every 10 minutes for 24 hours.
async function retryUnsent(mailer) {
  const s = db();
  if (!s || tableState !== true) return 0;
  const rows = await s.executeD1Query('SELECT id, created_at, rating, category, name, country, comment, tool, job_id FROM feedback WHERE emailed = 0 AND created_at < ? AND created_at > ? ORDER BY created_at LIMIT 10', [Date.now() - 2 * 60 * 1000, Date.now() - 24 * 3600 * 1000]).catch(() => null);
  const list = Array.isArray(rows) ? rows : (rows && (rows.results || rows.rows)) || [];
  let n = 0;
  for (const r of list) {
    try {
      await mailer.sendFeedbackEmail({ id: r.id, createdAt: r.created_at, rating: r.rating, category: r.category, categoryLabel: CATEGORIES[r.category] || r.category, name: r.name, country: r.country, comment: r.comment, tool: r.tool, jobId: r.job_id });
      await s.executeD1Query('UPDATE feedback SET emailed = 1 WHERE id = ?', [r.id]);
      n++;
    } catch (e) { break; }   // mail is still down: try again at the next sweep
  }
  return n;
}
function startRetry(mailer) { const t = setInterval(() => retryUnsent(mailer).catch(() => {}), 10 * 60 * 1000); t.unref(); return t; }

module.exports = { handler, retryUnsent, startRetry, validate, CATEGORIES, LIMITS, _reset: () => { hits.clear(); seenJobs.clear(); tableState = null; } };
