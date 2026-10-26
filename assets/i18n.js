/* FileCorner interface translations.
 *
 * - Dictionaries live in /assets/locales/<code>.js (one small file per language, loaded only when chosen; English is loaded first and is
 *   the fallback for every missing key). Nothing is fetched from any API when the language changes.
 * - Markup: data-i18n="key" (text), data-i18n-placeholder / -aria / -title="key" (attributes), data-i18n-html="key" (text with markup).
 * - Code: FileCornerI18n.t('key', 'English default', { n: 3 })  ->  "{n}" placeholders are filled in.
 * - The chosen language is kept in localStorage ("fc_lang"). The browser language is only SUGGESTED (a dismissible bar), never applied.
 * - <html lang> and <html dir> follow the language (Arabic is right-to-left).
 * - The selector lists every supported language. A search box at the top filters them by native name, English name or alias (assets/lang-meta.js);
 *   without a search the list is English first, then the languages that fit the visitor's country, then the rest. This only orders the list.
 *   The country comes from Cloudflare's /cdn-cgi/trace (the "loc" line only), else the time zone / browser language; it is cached in localStorage (fc_region, 7 days).
 * Uploaded documents are never translated; only the interface is.
 */
(function () {
  'use strict';
  var LANGS = [
    ['en', 'English'], ['hi', 'हिन्दी'], ['es', 'Español'], ['pt', 'Português'], ['fr', 'Français'], ['ar', 'العربية'],
    ['de', 'Deutsch'], ['it', 'Italiano'], ['nl', 'Nederlands'], ['pl', 'Polski'], ['ru', 'Русский'], ['uk', 'Українська'],
    ['ro', 'Română'], ['el', 'Ελληνικά'], ['cs', 'Čeština'], ['sv', 'Svenska'], ['da', 'Dansk'], ['nb', 'Norsk bokmål'],
    ['fi', 'Suomi'], ['hu', 'Magyar'], ['sk', 'Slovenčina'], ['hr', 'Hrvatski'], ['bg', 'Български'], ['sr', 'Српски'],
    ['sl', 'Slovenščina'], ['lt', 'Lietuvių'], ['lv', 'Latviešu'], ['et', 'Eesti'], ['tr', 'Türkçe'], ['ga', 'Gaeilge']
  ];
  var RTL = { ar: true };
  var KEY = 'fc_lang', DISMISS = 'fc_lang_suggest_dismissed';
  var dicts = {};
  var current = 'en';
  var loading = {};

  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: the choice just is not remembered */ } }
  function known(c) { return LANGS.some(function (l) { return l[0] === c; }); }

  function register(code, dict) { dicts[code] = dict; }
  function t(key, dflt, vars) {
    var s = (dicts[current] && dicts[current][key]);
    if (s == null) s = dicts.en && dicts.en[key];
    if (s == null) s = dflt != null ? dflt : key;
    if (vars) s = String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; });
    return s;
  }

  function apply(root) {
    root = root || document;
    var q = function (sel, fn) { Array.prototype.forEach.call(root.querySelectorAll(sel), fn); };
    q('[data-i18n]', function (el) { el.textContent = t(el.getAttribute('data-i18n'), el.getAttribute('data-i18n-default') || el.textContent); });
    q('[data-i18n-html]', function (el) { el.innerHTML = t(el.getAttribute('data-i18n-html'), el.innerHTML); });
    q('[data-i18n-placeholder]', function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'), el.getAttribute('placeholder'))); });
    q('[data-i18n-aria]', function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'), el.getAttribute('aria-label'))); });
    q('[data-i18n-title]', function (el) { el.setAttribute('title', t(el.getAttribute('data-i18n-title'), el.getAttribute('title'))); });
  }

  function loadLocale(code, cb) {
    if (dicts[code] || code === 'en' && dicts.en) return cb();
    if (loading[code]) { loading[code].push(cb); return; }
    loading[code] = [cb];
    var s = document.createElement('script');
    s.src = '/assets/locales/' + code + '.js';
    var done = function () { var l = loading[code]; delete loading[code]; l.forEach(function (f) { f(); }); };
    s.onload = done;
    s.onerror = done;                       // a missing file just means English is used
    document.head.appendChild(s);
  }

  function setLanguage(code, persist) {
    if (!known(code)) code = 'en';
    loadLocale('en', function () {
      loadLocale(code, function () {
        current = code;
        if (persist !== false) safeSet(KEY, code);
        var h = document.documentElement;
        h.setAttribute('lang', code === 'nb' ? 'nb' : code);
        h.setAttribute('dir', RTL[code] ? 'rtl' : 'ltr');
        apply();
        updateWidget();
        document.documentElement.classList.remove('fc-i18n-pending');
        try { document.dispatchEvent(new CustomEvent('fc:lang', { detail: { lang: code } })); } catch (e) { /* old browser */ }
      });
    });
  }

  // ---- the selector (globe button + list of native names) ------------------------------------------------------
  var widget, button, list, opts, search, empty, label;
  var META = function () { return window.FileCornerLangMeta || null; };
  var country = '';
  function nameOf(code) { for (var i = 0; i < LANGS.length; i++) if (LANGS[i][0] === code) return LANGS[i][1]; return code; }
  function updateWidget() {
    if (!widget) return;
    label.textContent = current.toUpperCase();
    button.setAttribute('aria-label', t('lang.choose', 'Choose language') + ': ' + current.toUpperCase() + ' (' + nameOf(current) + ')');
    Array.prototype.forEach.call(opts.children, function (li) { li.setAttribute('aria-selected', li.getAttribute('data-code') === current ? 'true' : 'false'); });
  }
  // Fills the options: the country-aware order when the search is empty, otherwise every supported language that matches the typed text
  function renderOptions(query) {
    var M = META(), langs = LANGS, hits = M && query && query.trim() ? M.search(query, LANGS) : null;
    if (!hits && M) langs = M.order(LANGS, country, navigator.languages || [navigator.language]).all;
    else if (hits) langs = hits;
    else if (query && query.trim()) {          // no metadata file: plain filter on the names shown
      var q = query.trim().toLowerCase();
      langs = LANGS.filter(function (l) { return l[1].toLowerCase().indexOf(q) >= 0 || l[0] === q; });
    }
    opts.innerHTML = '';
    langs.forEach(function (l) {
      var li = document.createElement('li');
      li.setAttribute('role', 'option'); li.setAttribute('data-code', l[0]); li.setAttribute('tabindex', '-1');
      li.setAttribute('lang', l[0]); li.textContent = l[1];
      li.addEventListener('click', function () { setLanguage(l[0]); closeList(); button.focus(); });
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.click(); }
        else if (e.key === 'ArrowDown' && li.nextSibling) { e.preventDefault(); li.nextSibling.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (li.previousSibling || search).focus(); }
        else if (e.key === 'Escape') { e.stopPropagation(); closeList(); button.focus(); }
        else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { search.focus(); }   // typing starts a search
      });
      opts.appendChild(li);
    });
    empty.hidden = langs.length > 0;
    empty.textContent = t('lang.none', 'No language found');
    updateWidget();
  }
  function closeList() { if (list) { list.classList.remove('open'); button.setAttribute('aria-expanded', 'false'); if (search && search.value) { search.value = ''; renderOptions(''); } } }
  function buildWidget() {
    widget = document.createElement('div');
    widget.id = 'lang-switch';
    widget.className = 'fc-lang';
    widget.innerHTML =
      '<button type="button" class="fc-lang-btn" aria-haspopup="listbox" aria-expanded="false">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 4 5.7 4 9s-1.4 6.4-4 9c-2.6-2.6-4-5.7-4-9s1.4-6.4 4-9z"/></svg>' +
      '<span class="fc-lang-code"></span><svg class="fc-chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.2 6 8l4-3.8"/></svg></button><div class="fc-lang-list"><div class="fc-lang-find"><input type="search" class="fc-lang-search" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"></div><ul class="fc-lang-opts" role="listbox"></ul><div class="fc-lang-none" role="status" hidden></div></div>';
    button = widget.querySelector('button');
    label = widget.querySelector('.fc-lang-code');
    list = widget.querySelector('.fc-lang-list');
    opts = widget.querySelector('.fc-lang-opts');
    search = widget.querySelector('.fc-lang-search');
    empty = widget.querySelector('.fc-lang-none');
    search.setAttribute('placeholder', t('lang.search', 'Search language'));
    search.setAttribute('aria-label', t('lang.search', 'Search language'));
    opts.setAttribute('aria-label', t('lang.choose', 'Choose language'));
    renderOptions('');
    search.addEventListener('input', function () { renderOptions(search.value); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' && opts.firstChild) { e.preventDefault(); opts.firstChild.focus(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (opts.firstChild) opts.firstChild.click(); }
      else if (e.key === 'Escape') { e.stopPropagation(); if (search.value) { search.value = ''; renderOptions(''); } else { closeList(); button.focus(); } }
    });
    button.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = !list.classList.contains('open');
      list.classList.toggle('open', open);
      button.setAttribute('aria-expanded', String(open));
      if (open) {
        // focus the current language once the list is visible (a hidden list cannot take focus); preventScroll: the page itself must not move
        requestAnimationFrame(function () {
          var sel = opts.querySelector('[aria-selected="true"]') || opts.firstChild;
          if (window.matchMedia && window.matchMedia('(pointer:coarse)').matches) { if (sel) sel.focus({ preventScroll: true }); }   // on touch screens focusing the search box would open the keyboard at once
          else search.focus({ preventScroll: true });
          if (sel) opts.scrollTop = Math.max(0, sel.offsetTop - 60);
        });
      }
    });
    document.addEventListener('click', function (e) { if (widget && !widget.contains(e.target)) closeList(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeList(); });
    document.addEventListener('fc:lang', function () { if (search) { search.setAttribute('placeholder', t('lang.search', 'Search language')); search.setAttribute('aria-label', t('lang.search', 'Search language')); empty.textContent = t('lang.none', 'No language found'); } });
    return widget;
  }

  // Country, only to order the list. Order of trust: a cached answer, Cloudflare's /cdn-cgi/trace on this site (we read the "loc" line only),
  // then the browser's time zone, then the region in the browser language (de-CH). No third-party service; nothing is sent anywhere.
  var REGION_KEY = 'fc_region', REGION_TTL = 7 * 24 * 3600 * 1000;
  function detectCountry() {
    var M = META(); if (!M) return;
    var cached = null; try { cached = JSON.parse(safeGet(REGION_KEY) || 'null'); } catch (e) { cached = null; }
    if (cached && cached.c && Date.now() - cached.t < REGION_TTL) { country = cached.c; renderOptions(search ? search.value : ''); return; }
    var fallback = function () {
      var tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* no Intl */ }
      return M.countryFromTimeZone(tz) || M.countryFromLanguages(navigator.languages || [navigator.language]);
    };
    var done = function (c, store) { country = c || ''; if (c && store) safeSet(REGION_KEY, JSON.stringify({ c: c, t: Date.now() })); if (search) renderOptions(search.value); };
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 2500);
    if (!window.fetch || location.protocol === 'file:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) { clearTimeout(timer); done(fallback(), false); return; }
    fetch('/cdn-cgi/trace', { cache: 'no-store', signal: ctl ? ctl.signal : undefined }).then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (txt) { clearTimeout(timer); var c = M.countryFromTrace(txt); done(c || fallback(), !!c); })
      .catch(function () { clearTimeout(timer); done(fallback(), false); });
  }

  function place() {
    if (document.getElementById('lang-switch')) return;
    var w = buildWidget();
    detectCountry();
    var search = document.getElementById('tool-search-input');
    if (search) {                                           // index.html: beside the search field (desktop); far right of the header row (phones)
      var box = document.getElementById('tool-search-box') || search.closest('.relative.hidden');   // the whole search pill, never an element inside it
      box.parentNode.insertBefore(w, box.nextSibling);          // right after the search field
      return;
    }
    // pages with a Home button inside a right-hand control group: the selector goes right next to it
    var homeLink = (document.querySelector('header [data-i18n="nav.home"]') || {}).parentNode;
    homeLink = homeLink && homeLink.closest ? homeLink.closest('a') : null;
    if (homeLink && homeLink.parentNode && !/justify-between/.test(homeLink.parentNode.className)) { homeLink.parentNode.insertBefore(w, homeLink.nextSibling); return; }
    var row = document.querySelector('header .justify-between') || document.querySelector('header > div > div') || document.querySelector('header');
    if (row) row.appendChild(w);                            // other pages: the far right of the header row
  }

  function suggest() {
    if (safeGet(KEY) || safeGet(DISMISS)) return;
    var nav = (navigator.languages && navigator.languages[0] || navigator.language || 'en').toLowerCase().split('-')[0];
    if (nav === 'no') nav = 'nb';
    if (nav === 'en' || !known(nav)) return;
    loadLocale(nav, function () {
      var bar = document.createElement('div');
      bar.className = 'fc-lang-suggest'; bar.setAttribute('role', 'status');
      var txt = (dicts[nav] && dicts[nav]['lang.suggest']) || ('Switch to ' + nameOf(nav) + '?');
      bar.innerHTML = '<span></span><button type="button" class="yes"></button><button type="button" class="no" aria-label="Dismiss">×</button>';
      bar.querySelector('span').textContent = txt;
      bar.querySelector('.yes').textContent = nameOf(nav);
      bar.querySelector('.yes').onclick = function () { bar.remove(); setLanguage(nav); };
      bar.querySelector('.no').onclick = function () { safeSet(DISMISS, '1'); bar.remove(); };
      document.body.appendChild(bar);
    });
  }

  var css = document.createElement('style');
  css.textContent =
    '.fc-lang{position:relative;display:inline-flex;flex-shrink:0;margin-inline-start:2px}' +
    '.fc-lang-btn{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 9px;border-radius:9999px;border:1px solid rgba(226,232,240,.9);background:rgba(241,245,249,.9);color:#334155;font-family:inherit;font-size:11px;font-weight:600;line-height:1;cursor:pointer;' +
      'transition:background-color .18s ease,border-color .18s ease,box-shadow .18s ease,color .18s ease}' +
    '.fc-lang-btn:hover{background:rgba(226,232,240,.95);border-color:#cbd5e1;color:#0f172a}' +
    '.fc-lang-btn:focus-visible{outline:none;border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.25)}' +
    '.fc-lang-btn svg{width:15px;height:15px;flex:none}.fc-lang-btn .fc-chev{width:10px;height:10px;opacity:.6;transition:transform .2s ease}' +
    '.fc-lang-btn[aria-expanded="true"] .fc-chev{transform:rotate(180deg)}' +
    '.fc-lang-code{display:inline;min-width:1.2em;text-align:center}' +
    /* the list: a short fade with a few pixels of movement; hidden lists take no clicks and no focus */
    '.fc-lang-list{position:absolute;inset-inline-end:0;top:calc(100% + 6px);z-index:80;margin:0;padding:6px;display:flex;flex-direction:column;width:210px;max-height:min(70vh,420px);overflow:hidden;background:#fff;border:1px solid rgb(226 232 240);border-radius:14px;box-shadow:0 12px 32px rgba(15,23,42,.18);' +
      'opacity:0;transform:translateY(-6px);visibility:hidden;pointer-events:none;transition:opacity .16s ease,transform .16s ease,visibility 0s linear .16s}' +
    '.fc-lang-list.open{opacity:1;transform:none;visibility:visible;pointer-events:auto;transition-delay:0s}' +
    '@media (max-width:768px){@supports (-webkit-touch-callout:none){.fc-lang-search{font-size:16px!important}}}' +
    '.fc-lang-find{flex:none;padding:2px 2px 6px}.fc-lang-search{display:block;width:100%;box-sizing:border-box;height:32px;padding:0 10px;border:1px solid rgb(226 232 240);border-radius:9px;background:#f8fafc;color:#1e293b;font-family:inherit;font-size:13px;outline:none}.fc-lang-search:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.2)}.fc-lang-search::placeholder{color:#94a3b8}' +
    '.fc-lang-opts{list-style:none;margin:0;padding:0;overflow-y:auto;overscroll-behavior:contain;flex:1 1 auto;min-height:0}.fc-lang-none{padding:12px 10px;font-size:13px;color:#64748b;text-align:center}.fc-lang-none[hidden]{display:none}' +
    '.fc-lang-list li{padding:8px 10px;border-radius:9px;font-size:13px;color:#1e293b;cursor:pointer;outline:none;opacity:0;transform:translateY(-3px);transition:opacity .16s ease,transform .16s ease,background-color .12s ease}' +
    '.fc-lang-list.open li{opacity:1;transform:none}' +
    '.fc-lang-list li:hover,.fc-lang-list li:focus{background:#eff6ff}.fc-lang-list li[aria-selected="true"]{font-weight:700;color:#1d4ed8}.fc-lang-list li{margin:0}' +
    'html[dir=rtl] .fc-lang-list{inset-inline-end:0}' +
    '@media (max-width:420px){.fc-lang-list{position:fixed;inset-inline-end:12px;top:64px;width:min(240px,calc(100vw - 24px))}}' +
    '@media (prefers-reduced-motion:reduce){.fc-lang-btn,.fc-lang-btn .fc-chev,.fc-lang-list,.fc-lang-list li{transition:none!important}.fc-lang-list{transform:none}.fc-lang-list li{transform:none;opacity:1}}' +
    '.fc-lang-suggest{position:fixed;z-index:90;left:50%;transform:translateX(-50%);bottom:14px;display:flex;gap:8px;align-items:center;max-width:calc(100vw - 24px);padding:8px 12px;background:#0f172a;color:#fff;border-radius:12px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.3)}' +
    '.fc-lang-suggest .yes{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:5px 10px;font-weight:700;cursor:pointer}.fc-lang-suggest .no{background:none;border:0;color:#cbd5e1;font-size:18px;cursor:pointer}' +
    /* fonts: system faces that cover each script; right-to-left pages mirror the flow without touching the layout widths */
    'html[lang=hi] body{font-family:"Nirmala UI","Noto Sans Devanagari","Mangal",system-ui,sans-serif}' +
    'html[lang=ar] body{font-family:"Segoe UI","Noto Naskh Arabic","Tahoma",system-ui,sans-serif}' +
    'html[lang=el] body,html[lang=ru] body,html[lang=uk] body,html[lang=bg] body,html[lang=sr] body{font-family:"Segoe UI","Noto Sans",system-ui,sans-serif}' +
    'html.fc-fit1 #nav-categories *{font-size:11.5px!important}html.fc-fit1 #nav-categories{gap:2px}html.fc-fit1 #tool-search-input{width:6rem!important}' +
    'html.fc-fit2 #nav-categories *{font-size:11px!important}html.fc-fit2 #nav-categories>*{padding-left:0!important;padding-right:0!important}html.fc-fit2 #tool-search-input{width:3.2rem!important}' +
    'html.fc-fit3 #tool-search-input{width:1.2rem!important}' +
    'html.fc-fit4 #nav-categories *{font-size:10.5px!important}html.fc-fit4 .fc-lang-btn .fc-chev{display:none}html.fc-fit4 #nav-categories{gap:0}' +
    /* phones: the header row keeps its exact order in Arabic too (menu button far left, logo next to it, language button far right) */
    '@media (max-width:1023px){html[dir=rtl] header .justify-between{direction:ltr}html[dir=rtl] .fc-lang-list{direction:rtl}}' +
    'html[dir=rtl] body{text-align:start}html[dir=rtl] .tracking-tight,html[dir=rtl] .tracking-wider{letter-spacing:0}';
  document.head.appendChild(css);

  // Longer labels (German, Russian, Greek ...) can push the desktop header wider than the window. Step by step: smaller category labels, then a
  // narrower search field, then the search field shows only its icon. English and Arabic normally fit without any step.
  function fitHeader() {
    var nav = document.getElementById('nav-categories');
    var h = document.documentElement;
    h.classList.remove('fc-fit1', 'fc-fit2', 'fc-fit3', 'fc-fit4');
    if (!nav || window.innerWidth < 1024) return;
    var row = nav.parentNode;
    var over = function () { var last = row.lastElementChild.getBoundingClientRect(), r = row.getBoundingClientRect(); return last.right > r.right + 0.5 || last.left < r.left - 0.5 || row.scrollWidth > row.clientWidth + 1; };
    var steps = ['fc-fit1', 'fc-fit2', 'fc-fit3', 'fc-fit4'];
    for (var i = 0; i < steps.length && over(); i++) h.classList.add(steps[i]);
  }
  document.addEventListener('fc:lang', function () { setTimeout(fitHeader, 0); });
  window.addEventListener('resize', fitHeader);
  window.addEventListener('load', fitHeader);

  window.FileCornerI18n = { t: t, apply: apply, setLanguage: setLanguage, register: register, languages: LANGS, current: function () { return current; } };

  function start() {
    place();
    var saved = safeGet(KEY);
    setLanguage(known(saved) ? saved : 'en', false);
    suggest();
  }
  setTimeout(function () { document.documentElement.classList.remove('fc-i18n-pending'); }, 1500);   // never leave a page hidden
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
