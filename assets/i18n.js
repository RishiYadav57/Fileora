/* FileCorner interface translations.
 *
 * - Dictionaries live in /assets/locales/<code>.js (one small file per language, loaded only when chosen; English is loaded first and is
 *   the fallback for every missing key). Nothing is fetched from any API when the language changes.
 * - Markup: data-i18n="key" (text), data-i18n-placeholder / -aria / -title="key" (attributes), data-i18n-html="key" (text with markup).
 * - Code: FileCornerI18n.t('key', 'English default', { n: 3 })  ->  "{n}" placeholders are filled in.
 * - The chosen language is kept in localStorage ("fc_lang"). The browser language is only SUGGESTED (a dismissible bar), never applied.
 * - <html lang> and <html dir> follow the language (Arabic is right-to-left).
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
  var widget, button, list, label;
  function nameOf(code) { for (var i = 0; i < LANGS.length; i++) if (LANGS[i][0] === code) return LANGS[i][1]; return code; }
  function updateWidget() {
    if (!widget) return;
    label.textContent = current.toUpperCase();
    button.setAttribute('aria-label', t('lang.choose', 'Choose language') + ': ' + nameOf(current));
    Array.prototype.forEach.call(list.children, function (li) { li.setAttribute('aria-selected', li.getAttribute('data-code') === current ? 'true' : 'false'); });
  }
  function closeList() { if (list) { list.hidden = true; button.setAttribute('aria-expanded', 'false'); } }
  function buildWidget() {
    widget = document.createElement('div');
    widget.id = 'lang-switch';
    widget.className = 'fc-lang';
    widget.innerHTML =
      '<button type="button" class="fc-lang-btn" aria-haspopup="listbox" aria-expanded="false">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 4 5.7 4 9s-1.4 6.4-4 9c-2.6-2.6-4-5.7-4-9s1.4-6.4 4-9z"/></svg>' +
      '<span class="fc-lang-code"></span></button><ul class="fc-lang-list" role="listbox" hidden></ul>';
    button = widget.querySelector('button');
    label = widget.querySelector('.fc-lang-code');
    list = widget.querySelector('ul');
    LANGS.forEach(function (l) {
      var li = document.createElement('li');
      li.setAttribute('role', 'option'); li.setAttribute('data-code', l[0]); li.setAttribute('tabindex', '-1');
      li.setAttribute('lang', l[0]); li.textContent = l[1];
      li.addEventListener('click', function () { setLanguage(l[0]); closeList(); button.focus(); });
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.click(); }
        else if (e.key === 'ArrowDown' && li.nextSibling) { e.preventDefault(); li.nextSibling.focus(); }
        else if (e.key === 'ArrowUp' && li.previousSibling) { e.preventDefault(); li.previousSibling.focus(); }
        else if (e.key === 'Escape') { closeList(); button.focus(); }
      });
      list.appendChild(li);
    });
    button.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = list.hidden;
      list.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      if (open) { var sel = list.querySelector('[aria-selected="true"]') || list.firstChild; sel.focus(); sel.scrollIntoView({ block: 'nearest' }); }
    });
    document.addEventListener('click', function (e) { if (widget && !widget.contains(e.target)) closeList(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeList(); });
    return widget;
  }

  function place() {
    if (document.getElementById('lang-switch')) return;
    var w = buildWidget();
    var search = document.getElementById('tool-search-input');
    if (search) {                                           // index.html: beside the search field (desktop); far right of the header row (phones)
      var box = search.closest('.relative');
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
    '.fc-lang{position:relative;display:inline-flex;flex-shrink:0}' +
    '.fc-lang-btn{display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 6px;border-radius:10px;border:1px solid rgb(226 232 240);background:#fff;color:#334155;font:600 11px/1 inherit;cursor:pointer}' +
    '.fc-lang-btn:hover{background:#f1f5f9}.fc-lang-btn:focus-visible{outline:2px solid #2563eb;outline-offset:2px}' +
    '.fc-lang-code{display:none;font-size:11px}@media (min-width:640px){.fc-lang-code{display:inline}}.fc-lang-btn svg{width:16px;height:16px}.fc-lang-btn{gap:3px}' +
    '.fc-lang-list{position:absolute;right:0;top:calc(100% + 6px);z-index:80;margin:0;padding:6px;list-style:none;width:210px;max-height:min(70vh,420px);overflow-y:auto;background:#fff;border:1px solid rgb(226 232 240);border-radius:14px;box-shadow:0 12px 32px rgba(15,23,42,.18)}' +
    '.fc-lang-list[hidden]{display:none}' +
    '.fc-lang-list li{padding:8px 10px;border-radius:9px;font-size:13px;color:#1e293b;cursor:pointer;outline:none}' +
    '.fc-lang-list li:hover,.fc-lang-list li:focus{background:#eff6ff}.fc-lang-list li[aria-selected="true"]{font-weight:700;color:#1d4ed8}' +
    'html[dir=rtl] .fc-lang-list{right:auto;left:0}' +
    '@media (max-width:420px){.fc-lang-list{position:fixed;right:12px;left:auto;top:64px;width:min(240px,calc(100vw - 24px))}html[dir=rtl] .fc-lang-list{left:12px;right:auto}}' +
    '.fc-lang-suggest{position:fixed;z-index:90;left:50%;transform:translateX(-50%);bottom:14px;display:flex;gap:8px;align-items:center;max-width:calc(100vw - 24px);padding:8px 12px;background:#0f172a;color:#fff;border-radius:12px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.3)}' +
    '.fc-lang-suggest .yes{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:5px 10px;font-weight:700;cursor:pointer}.fc-lang-suggest .no{background:none;border:0;color:#cbd5e1;font-size:18px;cursor:pointer}' +
    /* fonts: system faces that cover each script; right-to-left pages mirror the flow without touching the layout widths */
    'html[lang=hi] body{font-family:"Nirmala UI","Noto Sans Devanagari","Mangal",system-ui,sans-serif}' +
    'html[lang=ar] body{font-family:"Segoe UI","Noto Naskh Arabic","Tahoma",system-ui,sans-serif}' +
    'html[lang=el] body,html[lang=ru] body,html[lang=uk] body,html[lang=bg] body,html[lang=sr] body{font-family:"Segoe UI","Noto Sans",system-ui,sans-serif}' +
    'html.fc-fit1 #nav-categories *{font-size:11.5px!important}html.fc-fit1 #nav-categories{gap:2px}html.fc-fit1 #tool-search-input{width:6rem!important}' +
    'html.fc-fit2 #nav-categories *{font-size:11px!important}html.fc-fit2 #nav-categories>*{padding-left:0!important;padding-right:0!important}html.fc-fit2 #tool-search-input{width:3.2rem!important}' +
    'html.fc-fit3 #tool-search-input{width:1.2rem!important}' +
    /* phones: the header row keeps its exact order in Arabic too (menu button far left, logo next to it, language button far right) */
    '@media (max-width:1023px){html[dir=rtl] header .justify-between{direction:ltr}html[dir=rtl] .fc-lang-list{direction:rtl}}' +
    'html[dir=rtl] body{text-align:start}html[dir=rtl] .tracking-tight,html[dir=rtl] .tracking-wider{letter-spacing:0}';
  document.head.appendChild(css);

  // Longer labels (German, Russian, Greek ...) can push the desktop header wider than the window. Step by step: smaller category labels, then a
  // narrower search field, then the search field shows only its icon. English and Arabic normally fit without any step.
  function fitHeader() {
    var nav = document.getElementById('nav-categories');
    var h = document.documentElement;
    h.classList.remove('fc-fit1', 'fc-fit2', 'fc-fit3');
    if (!nav || window.innerWidth < 1024) return;
    var row = nav.parentNode;
    var over = function () { var last = row.lastElementChild.getBoundingClientRect(), r = row.getBoundingClientRect(); return last.right > r.right + 0.5 || last.left < r.left - 0.5 || row.scrollWidth > row.clientWidth + 1; };
    var steps = ['fc-fit1', 'fc-fit2', 'fc-fit3'];
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
