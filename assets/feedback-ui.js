/* "How was your conversion?" card for the download page. Optional: it never touches, delays or disables the download button.
 * Sends rating, category, REQUIRED country, optional name / comment, the tool id and the internal job id to POST /api/feedback.
 * No file names or contents. Country names come from the browser (Intl.DisplayNames) in the selected language; the country is chosen by the
 * visitor, never guessed from the address. */
(function () {
  'use strict';
  var slot = document.getElementById('feedback-slot');
  if (!slot) return;
  var I = window.FileCornerI18n;
  var t = function (k, d, v) { return I ? I.t(k, d, v) : (v ? String(d).replace(/\{(\w+)\}/g, function (m, x) { return v[x] != null ? v[x] : m; }) : d); };
  var params = new URLSearchParams(location.search);
  // single download: ?id=...   batch download: ?jobs=id:token,id:token  (the first job identifies the review)
  var jobId = params.get('id') || ((params.get('jobs') || '').match(/cjob_[a-f0-9]{32}/) || [''])[0];
  var tool = (params.get('tool') || '').toLowerCase();
  var doneKey = 'fc_feedback_' + (jobId || 'x');
  var COUNTRIES = (window.FILECORNER_COUNTRIES || []);
  var CATS = [['perfect', 'fb.c.perfect', 'Perfect conversion'], ['format', 'fb.c.format', 'Formatting issue'], ['missing', 'fb.c.missing', 'Missing content'],
              ['slow', 'fb.c.slow', 'Slow conversion'], ['download', 'fb.c.download', 'Download issue'], ['other', 'fb.c.other', 'Other issue']];
  var rating = 0, sending = false;
  var INPUT = 'mt-0.5 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm';
  var LABEL = 'block text-xs font-semibold text-slate-600';

  function done() { try { return jobId && localStorage.getItem(doneKey) === '1'; } catch (e) { return false; } }
  function mark() { try { if (jobId) localStorage.setItem(doneKey, '1'); } catch (e) { /* not remembered */ } }
  var esc = function (s) { return String(s).replace(/[<>&"]/g, ''); };

  slot.innerHTML =
    '<form id="fc-fb" class="rounded-2xl border border-slate-200 bg-white px-3.5 py-3 sm:px-4 shadow-sm" novalidate aria-labelledby="fc-fb-title">' +
    '<div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">' +
    '<div class="min-w-0"><h2 id="fc-fb-title" class="text-base sm:text-lg font-extrabold text-slate-900" data-i18n="fb.heading">Enjoying FileCorner? Share your feedback</h2>' +
    '<p class="mt-0.5 text-xs sm:text-[13px] leading-snug text-slate-500" data-i18n="fb.intro">Your feedback helps us improve our conversion quality, fix formatting issues, and make FileCorner more useful for everyone. Tell us what worked well or what we can do better.</p></div>' +
    '<div id="fc-stars" role="radiogroup" aria-labelledby="fc-fb-title" class="flex gap-0.5 shrink-0"></div></div>' +
    '<div class="mt-2 grid gap-2 sm:grid-cols-2">' +
    '<div><label class="' + LABEL + '" for="fc-cat" data-i18n="fb.category">What best describes it?</label><select id="fc-cat" class="' + INPUT + '"></select></div>' +
    '<div><label class="' + LABEL + '" for="fc-country"><span data-i18n="fb.country">Country</span> <span class="text-rose-600" aria-hidden="true">*</span></label>' +
    '<input id="fc-country" list="fc-countries" autocomplete="off" required aria-required="true" class="' + INPUT + '"><datalist id="fc-countries"></datalist></div></div>' +
    '<div class="mt-2"><label id="fc-comment-label" class="' + LABEL + '" for="fc-comment" data-i18n="fb.comment">Comment (optional)</label>' +
    '<textarea id="fc-comment" maxlength="1000" rows="2" class="' + INPUT + '"></textarea>' +
    '<div class="text-right text-[11px] leading-none text-slate-400"><span id="fc-count">0</span>/1000</div></div>' +
    '<div class="mt-1.5 grid items-end gap-2 sm:grid-cols-2"><div><label class="' + LABEL + '" for="fc-name" data-i18n="fb.name">Name (optional)</label>' +
    '<input id="fc-name" maxlength="60" autocomplete="off" class="' + INPUT + '"></div>' +
    '<div class="flex items-center gap-3 sm:justify-end"><p id="fc-msg" role="status" aria-live="polite" class="text-xs font-medium sm:text-right"></p>' +
    '<button id="fc-submit" type="submit" class="shrink-0 rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white hover:bg-slate-700 disabled:opacity-60" data-i18n="fb.submit">Submit Feedback</button></div></div>' +
    '<p class="mt-1.5 text-[11px] leading-snug text-slate-400" data-i18n="fb.privacy">Please do not include personal or confidential information.</p></form>';

  var form = slot.firstChild, stars = document.getElementById('fc-stars'), cat = document.getElementById('fc-cat'), msg = document.getElementById('fc-msg');
  var comment = document.getElementById('fc-comment'), btn = document.getElementById('fc-submit'), country = document.getElementById('fc-country');

  function drawStars() {
    stars.innerHTML = '';
    for (var i = 1; i <= 5; i++) {
      (function (n) {
        var b = document.createElement('button');
        b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(rating === n));
        b.setAttribute('aria-label', t('fb.star', '{n} of 5 stars', { n: n }));
        b.className = 'text-2xl leading-none px-0.5 ' + (n <= rating ? 'text-amber-400' : 'text-slate-300') + ' hover:text-amber-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded';
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
    country.placeholder = t('fb.countryPh', 'Select your country');
  }
  function codeFor(text) {                       // '' = nothing chosen, null = text that is not a country of the list
    text = String(text || '').trim().toLowerCase();
    if (!text) return '';
    var opts = document.getElementById('fc-countries').children;
    for (var i = 0; i < opts.length; i++) if (opts[i].value.toLowerCase() === text) return opts[i].getAttribute('data-code');
    if (/^[a-z]{2}$/.test(text) && COUNTRIES.indexOf(text.toUpperCase()) >= 0) return text.toUpperCase();
    return null;
  }
  function say(text, ok) { msg.textContent = text; msg.className = 'text-xs font-medium sm:text-right ' + (ok ? 'text-emerald-700' : 'text-rose-700'); }
  comment.addEventListener('input', function () { document.getElementById('fc-count').textContent = comment.value.length; });
  country.addEventListener('input', function () { country.classList.remove('border-rose-500'); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (sending) return;
    if (!rating) { say(t('fb.errRating', 'Please choose a star rating.'), false); return; }
    var code = codeFor(country.value);
    if (!code) {
      country.classList.add('border-rose-500'); country.focus();
      say(code === '' ? t('fb.errCountryRequired', 'Please select your country.') : t('fb.errCountry', 'Please select a country from the list.'), false);
      return;
    }
    sending = true; btn.disabled = true; btn.textContent = t('fb.sending', 'Sending…'); say('', true);
    var api = (window.FILEORA_CONFIG && FILEORA_CONFIG.apiBase) ? FILEORA_CONFIG.apiBase() : '';
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 20000);
    fetch(api + '/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ rating: rating, category: cat.value, name: document.getElementById('fc-name').value, country: code, comment: comment.value, tool: tool, jobId: jobId })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j }; });
    }).then(function (res) {
      // saved (200) or already saved for this conversion (409): the visitor is done; an e-mail problem on our side is never shown as a failure
      if (res.ok || res.status === 409) {
        mark();
        form.innerHTML = '<div class="py-1 text-center"><p class="text-base font-bold text-emerald-700" role="status"><span aria-hidden="true">★</span> ' + esc(t('fb.thanks', 'Thank you! Your feedback was sent.')) + '</p></div>';
        return;
      }
      throw res;
    }).catch(function (res) {
      sending = false; btn.disabled = false; btn.textContent = t('fb.submit', 'Submit Feedback');
      if (res && res.status === 429) say(t('fb.errLimit', 'Too many submissions. Please try again later.'), false);
      else if (res && (res.status === 400 || res.status === 503) && res.j && res.j.message) say(res.j.message, false);
      else say(t('fb.errFail', 'Could not send your feedback. Please try again.'), false);
    }).then(function () { clearTimeout(timer); });
  });

  if (done()) { form.innerHTML = '<p class="py-1 text-center text-sm font-semibold text-emerald-700" role="status">' + esc(t('fb.thanks', 'Thank you! Your feedback was sent.')) + '</p>'; return; }
  drawStars(); drawLists(); lowPrompt();
  document.addEventListener('fc:lang', function () { if (document.getElementById('fc-cat')) { drawLists(); drawStars(); lowPrompt(); if (I) I.apply(slot); btn.textContent = t('fb.submit', 'Submit Feedback'); } });
  if (I) I.apply(slot);
})();
