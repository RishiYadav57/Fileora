// Fileora R2 cleanup (Cloudflare Worker, cron trigger).
// The Render backend deletes expired files on a timer, but a free Render instance sleeps after ~15 minutes without traffic, so
// that timer does not run while it sleeps. This Worker runs on Cloudflare's schedule instead and physically deletes converted
// files that are older than MAX_AGE_MINUTES, whether or not the backend is awake.
//
// Safety rules:
//  - it only looks at keys the app writes: converted/cjob_<32 hex>/...
//  - it decides by the object's own upload time, never by the job database, so a D1 outage cannot make it delete anything early
//    (nor prevent deletion of files that are already past their time)
//  - MAX_AGE_MINUTES must stay larger than OUTPUT_RETENTION_MINUTES on the backend (default 60): the default of 75 leaves 15 minutes
//  - job records are not touched here; the backend removes the leftover record the next time it wakes up (a missing object counts
//    as already deleted)
const KEY = /^converted\/cjob_[a-f0-9]{32}\//;
const MAX_SCANNED = 20000; // per run; the next run continues

export async function sweep(env, now = Date.now()) {
  const maxAgeMs = (Number(env.MAX_AGE_MINUTES) || 75) * 60 * 1000;
  const cutoff = now - maxAgeMs;
  let cursor;
  let scanned = 0;
  let deleted = 0;
  do {
    const page = await env.BUCKET.list({ prefix: 'converted/', limit: 1000, cursor });
    scanned += page.objects.length;
    const stale = page.objects
      .filter((o) => KEY.test(o.key) && o.uploaded && new Date(o.uploaded).getTime() < cutoff)
      .map((o) => o.key);
    if (stale.length) {
      await env.BUCKET.delete(stale); // up to 1000 keys per call
      deleted += stale.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && scanned < MAX_SCANNED);
  return { scanned, deleted, cutoff: new Date(cutoff).toISOString() };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      sweep(env).then(
        (r) => console.log('[r2-cleanup]', JSON.stringify(r)),
        (e) => { console.error('[r2-cleanup] sweep failed:', e && e.name ? e.name : 'Error'); throw e; }
      )
    );
  }
};
