/* Analytics consent for FileCorner public pages.
 * Google Analytics 4 (G-PWHNVWWB7Q) is NOT loaded until the visitor presses "Accept". "Decline" (or a Global Privacy Control signal) keeps it off,
 * and a later withdrawal switches it off and removes the Google Analytics cookies this site could set. The choice is kept in this browser only
 * (localStorage key fc_consent). Only the page path and the referrer's path are reported (no query string or hash), so job ids and tokens never reach Analytics.
 * Not loaded on download.html at all. */
(function () {
  'use strict';
  var ID = 'G-PWHNVWWB7Q', KEY = 'fc_consent';
  var TEXT = {
    'consent.title': 'Cookies and analytics',
    'consent.text': 'We would like to use Google Analytics to measure how the site is used. It may set cookies and sends usage data to Google. Nothing is loaded unless you accept, and you can change your mind at any time.',
    'consent.accept': 'Accept', 'consent.decline': 'Decline', 'consent.policy': 'Cookie policy'
  };
  var store = {
    get: function () { try { return window.localStorage.getItem(KEY); } catch (e) { return null; } },
    set: function (v) { try { window.localStorage.setItem(KEY, v); } catch (e) { /* storage blocked: the choice only lasts for this page */ } }
  };
  var banner = null, loaded = false;

  function t(k) { var I = window.FileCornerI18n; return (I && I.t && I.t(k, TEXT[k])) || TEXT[k]; }

  function load() {
    if (loaded) return; loaded = true;
    window['ga-disable-' + ID] = false;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    var ref = ''; try { var r = new URL(document.referrer); ref = r.origin + r.pathname; } catch (e) { /* no referrer */ }   // a referrer such as a download link would carry its query string
    window.gtag('config', ID, { page_location: location.origin + location.pathname, page_referrer: ref });   // no query string, no hash
    var s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + ID;
    document.head.appendChild(s);
  }
  function unload() {
    window['ga-disable-' + ID] = true;     // stops any events from a script already running on this page
    var names = ['_ga', '_ga_' + ID.replace(/^G-/, ''), '_gid', '_gat'];
    var host = location.hostname, parts = host.split('.'), domains = [host, '.' + host];
    if (parts.length > 2) domains.push('.' + parts.slice(-2).join('.'));
    names.forEach(function (n) { domains.forEach(function (d) { document.cookie = n + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=' + d; }); document.cookie = n + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; });
  }

  function hide() { if (banner && banner.parentNode) banner.parentNode.removeChild(banner); banner = null; }
  function choose(v) { store.set(v); hide(); if (v === 'granted') load(); else unload(); }

  function show() {
    if (banner || !document.body) return;
    if (!document.getElementById('fc-consent-css')) {
      var css = document.createElement('style'); css.id = 'fc-consent-css';
      css.textContent = '.fc-consent{position:fixed;z-index:90;left:12px;right:12px;bottom:28px;max-width:420px;margin-inline:auto;padding:10px 12px;background:#fff;color:#334155;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 10px 28px rgba(15,23,42,.16);font-family:inherit;font-size:12px;line-height:1.4;opacity:0;transform:translateY(18px);transition:opacity .35s ease,transform .35s ease}.fc-consent.fc-in{opacity:1;transform:none}@media (prefers-reduced-motion:reduce){.fc-consent{transition:none;transform:none}}' +
        '.fc-consent b{display:block;color:#0f172a;font-size:12.5px;margin-bottom:2px}.fc-consent p{margin:0 0 8px}.fc-consent a{color:#2563eb;text-decoration:underline}' +
        '.fc-consent .fc-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.fc-consent button{font-family:inherit;font-size:12px;font-weight:600;border-radius:9999px;padding:5px 13px;cursor:pointer;border:1px solid #cbd5e1;background:#fff;color:#334155}' +
        '.fc-consent button.fc-yes{background:#2563eb;border-color:#2563eb;color:#fff}.fc-consent button:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}';
      document.head.appendChild(css);
    }
    banner = document.createElement('div');
    banner.className = 'fc-consent'; banner.setAttribute('role', 'dialog'); banner.setAttribute('aria-label', TEXT['consent.title']);
    banner.innerHTML = '<b data-i18n="consent.title"></b><p data-i18n="consent.text"></p><div class="fc-row"><button type="button" class="fc-yes" data-i18n="consent.accept"></button><button type="button" class="fc-no" data-i18n="consent.decline"></button><a href="/cookie-policy" data-i18n="consent.policy"></a></div>';
    ['title', 'text', 'accept', 'decline', 'policy'].forEach(function (k) { banner.querySelector('[data-i18n="consent.' + k + '"]').textContent = t('consent.' + k); });
    banner.querySelector('.fc-yes').addEventListener('click', function () { choose('granted'); });
    banner.querySelector('.fc-no').addEventListener('click', function () { choose('denied'); });
    document.body.appendChild(banner);
    var b = banner;
    setTimeout(function () { b.className = 'fc-consent fc-in'; }, 40);   // slide and fade in (a timer, not requestAnimationFrame, which pauses in background tabs)
  }

  function init() {
    var v = store.get();
    if (v === 'granted') load();
    else if (v === 'denied') { /* respected: nothing loads */ }
    else if (navigator.globalPrivacyControl === true) { /* Global Privacy Control: treated as a refusal, no prompt */ }
    else setTimeout(show, 2000);   // first visit: the notice slides in two seconds after the page opens
    document.addEventListener('click', function (e) { var el = e.target && e.target.closest ? e.target.closest('[data-fc-consent-open]') : null; if (el) { e.preventDefault(); hide(); show(); } });
    document.addEventListener('fc:lang', function () { if (banner) { hide(); show(); } });
  }

  window.FileCornerConsent = { get: function () { return store.get(); }, accept: function () { choose('granted'); }, decline: function () { choose('denied'); }, open: function () { hide(); show(); }, _state: function () { return { loaded: loaded, shown: !!banner }; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
