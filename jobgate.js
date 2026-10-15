/**
 * Shared gate for heavy conversion work (Render Free: 512 MB RAM, ~0.15 CPU).
 *
 *  - At most HEAVY_CONCURRENCY jobs run at once (default 1) across EVERY route that uses
 *    security.concurrencyLimiter (all conversions, PDF tools, OCR, LibreOffice, image tools).
 *  - Up to HEAVY_QUEUE_MAX further requests wait (default 4, for at most HEAVY_QUEUE_WAIT_MS);
 *    anything beyond that gets a clear 503 "server busy" before any upload is read.
 *  - Child processes started through execFileTracked() belong to the request that started them.
 *    If the client disconnects (Cancel, closed tab) they are killed as a process tree, no new child
 *    is started for that request, and the slot is released.
 *  - Structured memory log lines ("[mem] event=...") for job start/end, with Node memory, the memory of
 *    the job's child processes (Linux) and the container cgroup usage when readable.
 *
 * No file contents, file names or credentials are logged.
 */
const { AsyncLocalStorage } = require('async_hooks');
const { execFile, spawn } = require('child_process');
const fs = require('fs');

const als = new AsyncLocalStorage();
const IS_WIN = process.platform === 'win32';
const MAX_ACTIVE = Math.max(1, parseInt(process.env.HEAVY_CONCURRENCY || '1', 10) || 1);
const MAX_QUEUE = Math.max(0, parseInt(process.env.HEAVY_QUEUE_MAX || '4', 10) || 0);
const QUEUE_WAIT_MS = parseInt(process.env.HEAVY_QUEUE_WAIT_MS || '120000', 10) || 120000;
const SAMPLE_MS = 2000;

const active = new Set();
const queue = [];
let nextId = 1;

const mb = (n) => Math.round((n / 1048576) * 10) / 10;

function readCgroupBytes() {
  for (const f of ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes']) {
    try { return parseInt(fs.readFileSync(f, 'utf8').trim(), 10); } catch (e) { /* not available */ }
  }
  return null;
}

function nodeMem() {
  const m = process.memoryUsage();
  const cg = readCgroupBytes();
  return `rssMB=${mb(m.rss)} heapUsedMB=${mb(m.heapUsed)} heapTotalMB=${mb(m.heapTotal)} externalMB=${mb(m.external)}` +
    (cg ? ` cgroupMB=${mb(cg)}` : '');
}

function log(event, job, extra) {
  console.log(`[mem] event=${event}${job ? ` id=${job.id} tool=${job.tool}` : ''} active=${active.size} queued=${queue.length} ${nodeMem()}${extra ? ' ' + extra : ''}`);
}

// ---- child process tracking -------------------------------------------------
function killTree(child) {
  if (!child || child.exitCode !== null || child.killed && child.__killedTree) return;
  child.__killedTree = true;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { child.kill('SIGKILL'); }
    }
  } catch (e) { /* already gone */ }
}

function cancelledError() {
  const e = new Error('The conversion was cancelled.');
  e.code = 'ABORTED';
  return e;
}

function userFacingMessage(err, timedOut, aborted) {
  if (aborted) return 'The conversion was cancelled.';
  if (timedOut) return 'The conversion took too long and was stopped. Try a smaller or simpler file.';
  if (err && err.signal === 'SIGKILL') return 'The server ran out of resources while converting this file. Try a smaller or simpler file.';
  return 'The conversion process failed.';
}

/**
 * Drop-in replacement for promisify(execFile): same resolve value ({stdout, stderr}) and the same
 * error shape (code, stdout, stderr), but the child is tied to the current request, killed as a tree
 * on timeout/cancel, and the error message no longer contains command lines or file paths
 * (the raw text stays available in err.stderr for server-side logs and matching).
 */
function execFileTracked(cmd, args, opts) {
  const job = als.getStore();
  if (job && job.aborted) return Promise.reject(cancelledError());
  const { timeout, ...execOpts } = opts || {};
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = execFile(cmd, args, { ...execOpts, detached: !IS_WIN, windowsHide: true }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (job) job.children.delete(child);
      if (!err) return resolve({ stdout, stderr });
      const aborted = Boolean(job && job.aborted);
      if (err.signal === 'SIGKILL' && !timedOut && !aborted) {
        console.warn(`[mem] event=child_killed_by_signal signal=SIGKILL cmd=${String(cmd).split(/[\\/]/).pop()} active=${active.size} ${nodeMem()}`);
      }
      err.stdout = stdout;
      err.stderr = stderr;
      err.timedOut = timedOut;
      if (aborted) err.code = 'ABORTED';
      err.message = userFacingMessage(err, timedOut, aborted);
      reject(err);
    });
    const timer = timeout ? setTimeout(() => { timedOut = true; killTree(child); }, timeout) : null;
    if (job) job.children.add(child);
  });
}

// ---- child memory sampling (Linux only; Node's own numbers are in every log line) ---------------
function sampleJob(job) {
  const cg = readCgroupBytes();
  if (cg) job.peakCgroupMB = Math.max(job.peakCgroupMB, mb(cg));
  if (IS_WIN || !job.children.size) return;
  execFile('ps', ['-eo', 'pid=,ppid=,rss='], { timeout: 3000 }, (err, out) => {
    if (err || !out) return;
    const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const roots = new Set([...job.children].map((c) => c.pid));
    let total = 0;
    let grew = true;
    const members = new Set(roots);
    while (grew) {
      grew = false;
      for (const [pid, ppid] of rows) if (!members.has(pid) && members.has(ppid)) { members.add(pid); grew = true; }
    }
    for (const [pid, , rss] of rows) if (members.has(pid)) total += rss * 1024;
    job.peakChildMB = Math.max(job.peakChildMB, mb(total));
  });
}

// ---- gate -------------------------------------------------------------------------------------
function toolName(req) {
  return String((req.originalUrl || req.url || '').split('?')[0]).replace(/^\/api\//, '').slice(0, 60) || 'unknown';
}

function startJob(job) {
  active.add(job);
  job.startedAt = Date.now();
  job.sampler = setInterval(() => sampleJob(job), SAMPLE_MS);
  job.sampler.unref();
  log('job_start', job, `declaredSizeMB=${mb(job.declaredBytes)} waitedMs=${job.startedAt - job.queuedAt}`);
  als.run(job, job.next);
}

function pump() {
  while (active.size < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    clearTimeout(job.waitTimer);
    startJob(job);
  }
}

function uploadedBytesAndPaths(req) {
  const files = req.files ? (Array.isArray(req.files) ? req.files : Object.values(req.files).flat()) : (req.file ? [req.file] : []);
  const paths = new Set(files.map((f) => f.path).filter(Boolean));
  for (const p of req.__uploadPaths || []) paths.add(p); // includes uploads multer had not finished writing
  return { bytes: files.reduce((a, f) => a + (f.size || 0), 0), paths: [...paths] };
}

const BUSY_BODY = { error: 'SERVER_BUSY', message: 'The server is busy converting other files. Please try again in a minute.' };
let admitted = 0; // requests accepted by concurrencyLimiter: uploading + queued + running. Bounded by MAX_ACTIVE + MAX_QUEUE.

// Removes uploads that belong to a request that will not be processed (client left, queue wait expired, server busy).
function cleanupUploads(req) {
  const leftovers = uploadedBytesAndPaths(req).paths;
  const sweep = () => { for (const p of leftovers) { try { fs.unlinkSync(p); } catch (e) { /* already gone or still being closed */ } } };
  sweep();
  setTimeout(sweep, 3000).unref(); // a half-written upload may only be released once its stream closes
}

// Called before the upload body is read. Refuses new work immediately when the server already holds as many
// requests as it can run + queue, so uploads cannot pile up on disk. Returns false if it answered with 503.
function admit(req, res) {
  if (admitted >= MAX_ACTIVE + MAX_QUEUE) {
    log('job_rejected_busy', { id: '-', tool: toolName(req) });
    const reply = () => { if (!res.headersSent) { res.setHeader('Retry-After', '30'); res.status(503).json(BUSY_BODY); } };
    // read and discard the body so the browser receives the message instead of a reset connection
    if (parseInt(req.headers['content-length'] || '0', 10) > 60 * 1000 * 1000) { res.setHeader('Connection', 'close'); reply(); }
    else { req.on('end', reply); req.on('error', () => {}); req.resume(); }
    return false;
  }
  admitted++;
  res.once('close', () => {
    admitted = Math.max(0, admitted - 1);
    // client left during upload / queue wait / conversion, or the request ended in an error (multer's own cleanup can
    // fail on Windows while the file is still open); successful requests are cleaned up by their handlers
    if (!res.writableFinished || res.statusCode >= 400) cleanupUploads(req);
  });
  return true;
}

function finishJob(job, res) {
  const qi = queue.indexOf(job);
  if (qi !== -1) { // client left while waiting: nothing was started
    queue.splice(qi, 1);
    clearTimeout(job.waitTimer);
    return;
  }
  if (!active.has(job)) return;
  clearInterval(job.sampler);
  const finished = res.writableFinished;
  if (!finished) {
    job.aborted = true;
    for (const c of job.children) killTree(c);
    // upload that was never answered: remove it (finished jobs clean up through their own handlers)
  }
  sampleJob(job);
  active.delete(job);
  const status = finished ? `http_${res.statusCode}` : 'aborted_by_client';
  const { bytes } = uploadedBytesAndPaths(job.req);
  log('job_end', job, `status=${status} durationMs=${Date.now() - job.startedAt} sizeMB=${mb(bytes)} peakChildMB=${job.peakChildMB} peakCgroupMB=${job.peakCgroupMB}`);
  pump();
  // reading taken after cleanup, once the slot is free
  setImmediate(() => log('after_cleanup', null, `tool=${job.tool}`));
}

function enter(req, res, next) {
  // A request enters the run queue once. Routes without a multipart upload are entered by concurrencyLimiter and then
  // pass through heavyGate again after multer; the second call must not queue the request behind itself.
  if (req.__gateJob) return next();
  const job = {
    id: nextId++, tool: toolName(req), req, next, children: new Set(), aborted: false,
    declaredBytes: parseInt(req.headers['content-length'] || '0', 10) || 0,
    queuedAt: Date.now(), startedAt: 0, peakChildMB: 0, peakCgroupMB: 0
  };
  req.__gateJob = job;
  res.once('close', () => finishJob(job, res));

  if (active.size < MAX_ACTIVE) return startJob(job);

  if (queue.length >= MAX_QUEUE) {
    log('job_rejected_busy', job);
    cleanupUploads(req);
    res.setHeader('Retry-After', '30');
    return res.status(503).json(BUSY_BODY);
  }
  queue.push(job);
  log('job_queued', job);
  job.waitTimer = setTimeout(() => {
    const i = queue.indexOf(job);
    if (i === -1) return;
    queue.splice(i, 1);
    log('job_wait_timeout', job);
    cleanupUploads(req);
    if (!res.headersSent) {
      res.setHeader('Retry-After', '30');
      res.status(503).json(BUSY_BODY);
    }
  }, QUEUE_WAIT_MS);
}

function stats() {
  return { active: active.size, queued: queue.length, maxActive: MAX_ACTIVE, maxQueue: MAX_QUEUE };
}

function killAll() {
  for (const job of active) { job.aborted = true; for (const c of job.children) killTree(c); }
}
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => { killAll(); process.exit(0); });
}

module.exports = { enter, admit, cleanupUploads, execFileTracked, stats, currentJob: () => als.getStore() };
