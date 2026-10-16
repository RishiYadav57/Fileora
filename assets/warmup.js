/* Fileora backend warm-up. Loaded (deferred) by every public page.
 * A free Render service goes to sleep after ~15 minutes without traffic; the first request then takes 60-90 s while it
 * boots. Sending one tiny request as soon as a visitor lands starts that boot while they read the page / pick a file.
 *
 *  - GET /health only: no conversion, no queue slot, no upload, nothing expensive is initialised on the server.
 *  - Never blocks rendering or interaction: runs after load, ignores every failure.
 *  - At most one request per page view, none if one was sent in the last 4 minutes (any page, any tab), and at most
 *    three follow-up checks (10 s apart) while the server is still starting. No endless polling.
 *  - Exposes window.FileoraWarm.state ('idle' | 'warming' | 'starting' | 'ready' | 'failed') so the converter can tell the
 *    visitor honestly that the server is starting instead of looking frozen.
 * It cannot keep a free instance awake: a visitor who arrives after the service slept still waits for it to boot.
 */
(function () {
  'use strict';
  var base = (window.FILEORA_CONFIG && window.FILEORA_CONFIG.backend()) || location.origin; // shared config (assets/config.js)
  var KEY = 'fileora_warm_at';
  var FRESH_MS = 4 * 60 * 1000;
  var REQUEST_TIMEOUT_MS = 8000;
  var FOLLOW_UPS = 3;
  var FOLLOW_UP_GAP_MS = 10000;

  var W = window.FileoraWarm = { state: 'idle', backend: base, startedAt: 0, readyAt: 0, attempts: 0 };

  function set(state) {
    W.state = state;
    if (state === 'ready') W.readyAt = Date.now();
    try { window.dispatchEvent(new CustomEvent('fileora:warm', { detail: { state: state } })); } catch (e) {}
  }

  function ping() {
    W.attempts++;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { try { ctl.abort(); } catch (e) {} }, REQUEST_TIMEOUT_MS) : null;
    return fetch(base + '/health', { cache: 'no-store', mode: 'cors', credentials: 'omit', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (timer) clearTimeout(timer); return r.ok; })
      .catch(function () { if (timer) clearTimeout(timer); return false; });
  }

  function recentlyWarmed() {
    try {
      var t = parseInt(sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || '0', 10);
      return t && Date.now() - t < FRESH_MS;
    } catch (e) { return false; }
  }
  function remember() {
    var now = String(Date.now());
    try { sessionStorage.setItem(KEY, now); } catch (e) {}
    try { localStorage.setItem(KEY, now); } catch (e) {}
  }

  function start() {
    if (W.startedAt || typeof fetch !== 'function') return;
    W.startedAt = Date.now();
    if (recentlyWarmed()) { set('ready'); return; }
    set('warming');
    remember();
    ping().then(function (ok) {
      if (ok) { set('ready'); return; }
      set('starting'); // no answer within the short timeout: most likely a cold start in progress
      var left = FOLLOW_UPS;
      (function next() {
        if (left-- <= 0) { set('failed'); return; }
        setTimeout(function () {
          ping().then(function (ok2) { if (ok2) set('ready'); else next(); });
        }, FOLLOW_UP_GAP_MS);
      })();
    });
  }

  // after the page has finished loading, so the request never competes with rendering
  if (document.readyState === 'complete') setTimeout(start, 0);
  else window.addEventListener('load', function () { setTimeout(start, 0); }, { once: true });
})();
