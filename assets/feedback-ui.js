/* "How was your conversion?" card for the download page. Optional: it never touches, delays or disables the download button.
 * Sends rating, optional name / country / comment, the tool id and the internal job id to POST /api/feedback. No file names or contents.
 * Country names come from the browser (Intl.DisplayNames) in the selected language; nothing is guessed from the visitor's address. */
(function () {
  'use strict';
  var slot = document.getElementById('feedback-slot');
  if (!slot) return;
  var I = window.FileCornerI18n;
  var t = function (k, d, v) { return I ? I.t(k, d, v) : (v ? String(d).replace(/\{(\w+)\}/g, function (m, x) { return v[x] != null ? v[x] : m; }) : d); };
  var params = new URLSearchParams(location.search);
  var jobId = params.get('id') || '';
  var tool = (params.get('tool') || '').toLowerCase();
  var doneKey = 'fc_feedback_' + (jobId || 'x');
  var COUNTRIES = (window.FILECORNER_COUNTRIES || []);
  var CATS = [['perfect', 'fb.c.perfect', 'Perfect conversion'], ['format', 'fb.c.format', 'Formatting issue'], ['missing', 'fb.c.missing', 'Missing content'],
              ['slow', 'fb.c.slow', 'Slow conversion'], ['download', 'fb.c.download', 'Download issue'], ['other', 'fb.c.other', 'Other issue']];
  var rating = 0, sending = false;

  function done() { try { return jobId && localStorage.getItem(doneKey) === '1'; } catch (e) { return false; } }
  function mark() { try { if (jobId) localStorage.setItem(doneKey, '1'); } catch (e) { /* not remembered */ } }

  slot.innerHTML =
    '<form id="fc-fb" class="mt-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm" novalidate aria-labelledby="fc-fb-title">' +
    '<h2 id="fc-fb-title" class="text-base sm:text-lg font-extrabold text-slate-900" data-i18n="fb.title">How was your conversion?</h2>' +
    '<div class="mt-3"><div class="text-xs font-semibold text-slate-600" data-i18n="fb.rating">Your rating</div>' +
    '<div id="fc-stars" role="radiogroup" aria-labelledby="fc-fb-title" class="mt-1 flex gap-1"></div></div>' +
    '<div class="mt-3"><label class="block text-xs font-semibold text-slate-600" for="fc-cat" data-i18n="fb.category">What best describes it?</label>' +
    '<select id="fc-cat" class="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"></select></div>' +
    '<div id="fc-low-wrap" class="mt-3"><label id="fc-comment-label" class="block text-xs font-semibold text-slate-600" for="fc-comment" data-i18n="fb.comment">Comment (optional)</label>' +
    '<textarea id="fc-comment" maxlength="1000" rows="2" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"></textarea>' +
    '<div class="mt-0.5 text-right text-[11px] text-slate-400"><span id="fc-count">0</span>/1000</div></div>' +
    '<div class="mt-2 grid gap-3 sm:grid-cols-2"><div><label class="block text-xs font-semibold text-slate-600" for="fc-name" data-i18n="fb.name">Name (optional)</label>' +
    '<input id="fc-name" maxlength="60" autocomplete="off" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"></div>' +
    '<div><label class="block text-xs font-semibold text-slate-600" for="fc-country" data-i18n="fb.country">Country (optional)</label>' +
    '<input id="fc-country" list="fc-countries" autocomplete="off" class="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"><datalist id="fc-countries"></datalist></div></div>' +
    '<p class="mt-2 text-[11px] text-slate-400" data-i18n="fb.privacy">Please do not include personal or confidential information.</p>' +
    '<div class="mt-3 flex flex-wrap items-center gap-3"><button id="fc-submit" type="submit" class="rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-60" data-i18n="fb.submit">Submit Feedback</button>' +
    '<p id="fc-msg" role="status" aria-live="polite" class="text-sm font-medium"></p></div></form>';

  var form = slot.firstChild, stars = document.getElementById('fc-stars'), cat = document.getElementById('fc-cat'), msg = document.getElementById('fc-msg');
  var comment = document.getElementById('fc-comment'), btn = document.getElementById('fc-submit'), country = document.getElementById('fc-country');

  function drawStars() {
    stars.innerHTML = '';
    for (var i = 1; i <= 5; i++) {
      (function (n) {
        var b = document.createElement('button');
        b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(rating === n));
        b.setAttribute('aria-label', t('fb.star', '{n} of 5 stars', { n: n }));
        b.className = 'text-3xl leading-none px-0.5 ' + (n <= rating ? 'text-amber-400' : 'text-slate-300') + ' hover:text-amber-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded';
        b.textContent = '★';
        b.onclick = function () { rating = n; drawStars(); lowPrompt(); };
        stars.appendChild(b);
      })(i);
    }
  }
  function lowPrompt() {            // 1-3 stars: a short optional follow-up; 4-5 stays quick (same box, shorter label)
    var low = rating >= 1 && rating <= 3;
    document.getElementById('fc-comment-label').textContent = low ? t('fb.commentLow', 'What went wrong? (optional)') : t('fb.comment', 'Comment (optional)');
    comment.rows = low ? 3 : 2;
  }
  function drawLists() {
    var sel = cat.value;
    cat.innerHTML = '';
    CATS.forEach(function (c) { var o = document.createElement('option'); o.value = c[0]; o.textContent = t(c[1], c[2]); cat.appendChild(o); });
    if (sel) cat.value = sel;
    var dl = document.getElementById('fc-countries'), lang = (I && I.current && I.current()) || 'en', names = null;
    try { names = new Intl.DisplayNames([lang], { type: 'region' }); } catch (e) { try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e2) { names = null; } }
    var items = COUNTRIES.map(function (c) { var n = c; try { n = names ? names.of(c) : c; } catch (e) { /* keep code */ } return [c, n]; });
    items.sort(function (a, b) { return String(a[1]).localeCompare(String(b[1]), lang); });
    dl.innerHTML = '';
    items.forEach(function (it) { var o = document.createElement('option'); o.value = it[1]; o.setAttribute('data-code', it[0]); dl.appendChild(o); });
    country.placeholder = t('fb.countryPh', 'Start typing a country');
  }
  function codeFor(text) {
    text = String(text || '').trim().toLowerCase();
    if (!text) return '';
    var opts = document.getElementById('fc-countries').children;
    for (var i = 0; i < opts.length; i++) if (opts[i].value.toLowerCase() === text) return opts[i].getAttribute('data-code');
    if (/^[a-z]{2}$/.test(text) && COUNTRIES.indexOf(text.toUpperCase()) >= 0) return text.toUpperCase();
    return null;
  }
  function say(text, ok) { msg.textContent = text; msg.className = 'text-sm font-medium ' + (ok ? 'text-emerald-700' : 'text-rose-700'); }
  comment.addEventListener('input', function () { document.getElementById('fc-count').textContent = comment.value.length; });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (sending) return;
    if (!rating) { say(t('fb.errRating', 'Please choose a star rating.'), false); return; }
    var code = codeFor(country.value);
    if (code === null) { say(t('fb.errCountry', 'Please choose a country from the list, or leave it empty.'), false); return; }
    sending = true; btn.disabled = true; btn.textContent = t('fb.sending', 'Sending…'); say('', true);
    var api = (window.FILEORA_CONFIG && FILEORA_CONFIG.apiBase) ? FILEORA_CONFIG.apiBase() : '';
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 20000);
    fetch(api + '/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ rating: rating, category: cat.value, name: document.getElementById('fc-name').value, country: code || '', comment: comment.value, tool: tool, jobId: jobId })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    }).then(function (res) {
      if (res.ok || res.status === 409) {
        mark();
        form.innerHTML = '<div class="py-2 text-center"><div class="text-2xl" aria-hidden="true">★</div><p class="mt-1 text-base font-bold text-emerald-700" role="status">' +
          (t('fb.thanks', 'Thank you! Your feedback was sent.')).replace(/[<>&]/g, '') + '</p></div>';
        return;
      }
      throw res;
    }).catch(function (res) {
      sending = false; btn.disabled = false; btn.textContent = t('fb.submit', 'Submit Feedback');
      if (res && res.status === 429) say(t('fb.errLimit', 'Too many submissions. Please try again later.'), false);
      else if (res && res.status === 400 && res.j && res.j.message) say(res.j.message, false);
      else say(t('fb.errFail', 'Could not send your feedback. Please try again.'), false);
    }).then(function () { clearTimeout(timer); });
  });

  if (done()) { form.innerHTML = '<p class="py-2 text-center text-sm font-semibold text-emerald-700" role="status">' + t('fb.thanks', 'Thank you! Your feedback was sent.').replace(/[<>&]/g, '') + '</p>'; return; }
  drawStars(); drawLists(); lowPrompt();
  document.addEventListener('fc:lang', function () { if (document.getElementById('fc-cat')) { drawLists(); drawStars(); lowPrompt(); if (I) I.apply(slot); btn.textContent = t('fb.submit', 'Submit Feedback'); } });
  if (I) I.apply(slot);
})();
