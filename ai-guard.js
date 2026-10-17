/**
 * Protects the Gemini API key. Every route that calls Gemini (AI Summarizer, Translate Document, AI table finder) is limited to
 * ONE document per client address per 24 hours.
 *
 * One "use" = one document run. The page splits a document into chunks and sends each chunk as its own request, so the page tags every
 * request of a run with the same random id (X-Ai-Run). The first request from an address opens the use; further requests are accepted
 * only with the same run id, for the same kind of operation, within RUN_MINUTES and up to MAX_CALLS_PER_RUN requests. Anything else from
 * that address is answered with 429 until 24 hours after the use started. A request without a run id is a run of exactly one request.
 *
 * Addresses are stored hashed (IPv6 reduced to its /64 so a visitor cannot rotate through addresses of one network). Usage is kept in
 * memory and, when a database is available (Cloudflare D1 or the local SQLite file), in table ai_usage so it survives restarts.
 * A request that ends in an error (invalid input, or a failure on our side) is given back.
 */
const crypto = require('crypto');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const RUN_MS = (parseInt(process.env.AI_RUN_MINUTES, 10) || 30) * 60 * 1000;
const MAX_CALLS_PER_RUN = parseInt(process.env.AI_MAX_CALLS_PER_RUN, 10) || 40;
const MAX_BODY_BYTES = 2.5 * 1000 * 1000;         // a 3 MB document yields far less text than this; larger bodies are refused unread
const SALT = process.env.AI_GUARD_SALT || 'fileora-ai-guard';
const RUN_ID = /^[a-f0-9]{16,32}$/;

const memory = new Map();                          // ipHash -> { runId, op, startedAt, calls }
let storage = null;
let tableReady = null;
function db() {
  if (storage === null) { try { storage = require('./storage'); } catch (e) { storage = false; } }
  return storage && storage.executeD1Query ? storage : null;
}
async function ensureTable() {
  const s = db();
  if (!s) return false;
  if (!tableReady) {
    tableReady = s.executeD1Query('CREATE TABLE IF NOT EXISTS ai_usage (ip_hash TEXT PRIMARY KEY, run_id TEXT, op TEXT, started_at INTEGER NOT NULL, calls INTEGER NOT NULL)')
      .then(() => true).catch((e) => { console.warn('[ai-guard] usage table unavailable, using memory only:', e.message); tableReady = null; return false; });
  }
  return tableReady;
}
async function dbRead(h) {
  try {
    if (!(await ensureTable())) return null;
    const rows = await db().executeD1Query('SELECT run_id, op, started_at, calls FROM ai_usage WHERE ip_hash = ?', [h]);
    const r = rows && rows[0];
    return r ? { runId: r.run_id, op: r.op, startedAt: Number(r.started_at), calls: Number(r.calls) } : null;
  } catch (e) { return null; }
}
function dbWrite(h, rec) {
  ensureTable().then((ok) => {
    if (!ok) return;
    const p = rec
      ? db().executeD1Query('INSERT OR REPLACE INTO ai_usage (ip_hash, run_id, op, started_at, calls) VALUES (?, ?, ?, ?, ?)', [h, rec.runId, rec.op, rec.startedAt, rec.calls])
      : db().executeD1Query('DELETE FROM ai_usage WHERE ip_hash = ?', [h]);
    return p;
  }).catch(() => {});
}

// IPv6: keep the /64 network part; IPv4 (also ::ffff:a.b.c.d) as is
function normaliseIp(ip) {
  ip = String(ip || '').trim().toLowerCase().replace(/^::ffff:/, '');
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
const hashIp = (ip) => crypto.createHash('sha256').update(SALT + '|' + normaliseIp(ip)).digest('hex');

function describeWait(ms) {
  const h = Math.ceil(ms / 3600000);
  return h <= 1 ? 'about an hour' : `about ${h} hours`;
}

/** Express middleware for one operation ('summarize' | 'translate' | 'tables'). `getIp` returns the client address. */
function aiGuard(op, getIp) {
  return async (req, res, next) => {
    // the text of a document of at most 3 MB is far smaller than this
    const declared = parseInt(req.headers['content-length'] || '0', 10) || 0;
    if (declared > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'FILE_TOO_LARGE', message: 'Maximum file size is 3 MB.' });
    }
    const h = hashIp(getIp(req));
    const runHeader = String(req.headers['x-ai-run'] || '');
    const runId = RUN_ID.test(runHeader) ? runHeader : null;
    const now = Date.now();

    let rec = memory.get(h);
    if (!rec) {
      rec = await dbRead(h);
      if (rec && !memory.has(h)) memory.set(h, rec);
      rec = memory.get(h) || rec;
    }
    if (rec && now - rec.startedAt >= WINDOW_MS) { memory.delete(h); rec = null; }

    // everything below is synchronous: two simultaneous requests cannot both open a use
    let allowed = false;
    let reason = 'AI_DAILY_LIMIT';
    if (!rec) {
      rec = { runId, op, startedAt: now, calls: 1 };
      memory.set(h, rec);
      allowed = true;
    } else if (runId && rec.runId === runId && rec.op === op && now - rec.startedAt < RUN_MS) {
      if (rec.calls < MAX_CALLS_PER_RUN) { rec.calls++; allowed = true; } else { reason = 'AI_RUN_TOO_LONG'; }
    }
    if (!allowed) {
      const wait = Math.max(1000, rec.startedAt + WINDOW_MS - now);
      res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
      return res.status(429).json({
        error: reason,
        message: reason === 'AI_RUN_TOO_LONG'
          ? 'This document needs more AI requests than one use allows. Please try a shorter document.'
          : `You have reached today's limit for this feature. Please try again in ${describeWait(wait)}.`,
        retryAfterSec: Math.ceil(wait / 1000)
      });
    }
    dbWrite(h, rec);
    // a request that did not produce a result (invalid input, or a failure on our side) does not use up the day
    res.once('finish', () => {
      if (res.statusCode >= 400) {
        const cur = memory.get(h);
        if (cur && cur === rec) {
          cur.calls = Math.max(0, cur.calls - 1);
          if (cur.calls === 0) { memory.delete(h); dbWrite(h, null); } else dbWrite(h, cur);
        }
      }
    });
    next();
  };
}

module.exports = { aiGuard, normaliseIp, hashIp, _memory: memory, WINDOW_MS, MAX_CALLS_PER_RUN };
