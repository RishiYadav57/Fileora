/* Language metadata for the FileCorner language selector: search names/aliases, country recommendations and the pure ordering/search functions.
 * Only languages that exist in assets/i18n.js (the supported list) are ever returned; codes here that are not supported are ignored.
 * Contains no personal data. Loaded before assets/i18n.js; the selector still works (default order, plain filter) without it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FileCornerLangMeta = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // code -> English name and common alternative spellings (the native name comes from the supported list itself)
  var NAMES = {
    en: ['English', 'Inglés', 'Anglais', 'Englisch'],
    hi: ['Hindi', 'Hindustani', 'Devanagari'],
    es: ['Spanish', 'Castellano', 'Espanol', 'Castilian'],
    pt: ['Portuguese', 'Portugues', 'Brazilian', 'Brasileiro'],
    fr: ['French', 'Francais', 'Français', 'Francaise'],
    ar: ['Arabic', 'Arabi', 'Arabe'],
    de: ['German', 'Deutsch', 'Allemand', 'Aleman'],
    it: ['Italian', 'Italiano', 'Italien'],
    nl: ['Dutch', 'Nederlands', 'Flemish', 'Vlaams', 'Hollandsk'],
    pl: ['Polish', 'Polski', 'Polonais'],
    ru: ['Russian', 'Russkiy', 'Russkij', 'Russe'],
    uk: ['Ukrainian', 'Ukrainska', 'Ukrayinska'],
    ro: ['Romanian', 'Romana', 'Roumain'],
    el: ['Greek', 'Ellinika', 'Hellenic', 'Grec'],
    cs: ['Czech', 'Cestina', 'Cesky', 'Bohemian'],
    sv: ['Swedish', 'Svenska', 'Suédois'],
    da: ['Danish', 'Dansk', 'Danois'],
    nb: ['Norwegian', 'Norsk', 'Bokmal', 'Norvégien'],
    fi: ['Finnish', 'Suomi', 'Finnois'],
    hu: ['Hungarian', 'Magyar', 'Hongrois'],
    sk: ['Slovak', 'Slovencina', 'Slovensky'],
    hr: ['Croatian', 'Hrvatski', 'Croate'],
    bg: ['Bulgarian', 'Balgarski', 'Bulgare'],
    sr: ['Serbian', 'Srpski', 'Serbe'],
    sl: ['Slovenian', 'Slovene', 'Slovenscina'],
    lt: ['Lithuanian', 'Lietuviu', 'Lituanien'],
    lv: ['Latvian', 'Latviesu', 'Letton'],
    et: ['Estonian', 'Eesti', 'Estonien'],
    tr: ['Turkish', 'Turkce', 'Turc'],
    ga: ['Irish', 'Gaelic', 'Gaeilge', 'Irish Gaelic']
  };

  // country (ISO 3166-1 alpha-2) -> recommended languages after English, most relevant first
  var COUNTRY = {
    IN: ['hi'], NP: ['hi'], FJ: ['hi'],
    FR: ['fr'], MC: ['fr'], LU: ['fr', 'de'], CA: ['fr'], HT: ['fr'],
    DE: ['de'], AT: ['de'], LI: ['de'],
    CH: ['de', 'fr', 'it'],
    BE: ['fr', 'nl'],
    NL: ['nl'], SR: ['nl'], SX: ['nl'],
    IT: ['it'], SM: ['it'], VA: ['it'],
    ES: ['es'], PT: ['pt'], BR: ['pt'],
    PL: ['pl'], RU: ['ru', 'uk'], BY: ['ru'], KZ: ['ru'], KG: ['ru'],
    UA: ['uk', 'ru'], RO: ['ro'], MD: ['ro', 'ru'], GR: ['el'], CY: ['el', 'tr'],
    CZ: ['cs', 'sk'], SK: ['sk', 'cs'], SE: ['sv'], DK: ['da'], NO: ['nb'], FI: ['fi', 'sv'], HU: ['hu'],
    HR: ['hr'], BA: ['hr', 'sr'], BG: ['bg'], RS: ['sr', 'hr'], ME: ['sr', 'hr'], SI: ['sl', 'hr'],
    LT: ['lt', 'pl'], LV: ['lv', 'ru'], EE: ['et', 'ru', 'fi'],
    TR: ['tr'], IE: ['ga'], GB: [], US: ['es'],
    DZ: ['ar', 'fr'], MA: ['ar', 'fr'], TN: ['ar', 'fr'], LB: ['ar', 'fr'],
    AO: ['pt'], MZ: ['pt'], CV: ['pt'], GW: ['pt'], ST: ['pt']
  };

  // regional fallbacks for countries without an entry above (country lists per region)
  var REGIONS = [
    { langs: ['es'], countries: 'MX AR CO CL PE VE EC GT CU BO DO HN PY SV NI CR PA UY PR GQ' },
    { langs: ['ar'], countries: 'AE SA EG IQ JO SY YE OM KW QA BH SD PS LY MR SO DJ KM' },
    { langs: ['fr'], countries: 'SN CI CM CD CG GA ML BF NE TD GN BJ TG MG BI RW CF' }
  ];

  // IANA time zone -> country, used only when the country itself is unknown
  var TZ = {
    'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Vienna': 'AT', 'Europe/Zurich': 'CH',
    'Europe/Brussels': 'BE', 'Europe/Amsterdam': 'NL', 'Europe/Rome': 'IT', 'Europe/Madrid': 'ES', 'Europe/Lisbon': 'PT', 'America/Sao_Paulo': 'BR',
    'Europe/Warsaw': 'PL', 'Europe/Moscow': 'RU', 'Europe/Kiev': 'UA', 'Europe/Kyiv': 'UA', 'Europe/Bucharest': 'RO', 'Europe/Athens': 'GR',
    'Europe/Prague': 'CZ', 'Europe/Bratislava': 'SK', 'Europe/Stockholm': 'SE', 'Europe/Copenhagen': 'DK', 'Europe/Oslo': 'NO', 'Europe/Helsinki': 'FI',
    'Europe/Budapest': 'HU', 'Europe/Zagreb': 'HR', 'Europe/Sofia': 'BG', 'Europe/Belgrade': 'RS', 'Europe/Ljubljana': 'SI', 'Europe/Vilnius': 'LT',
    'Europe/Riga': 'LV', 'Europe/Tallinn': 'EE', 'Europe/Istanbul': 'TR', 'Europe/Dublin': 'IE', 'Europe/London': 'GB', 'Asia/Dubai': 'AE',
    'Asia/Riyadh': 'SA', 'Africa/Cairo': 'EG', 'Africa/Casablanca': 'MA', 'Africa/Algiers': 'DZ', 'Africa/Tunis': 'TN', 'Asia/Baghdad': 'IQ',
    'Asia/Amman': 'JO', 'Asia/Beirut': 'LB', 'Asia/Kuwait': 'KW', 'Asia/Qatar': 'QA', 'America/Mexico_City': 'MX', 'America/Argentina/Buenos_Aires': 'AR',
    'America/Bogota': 'CO', 'America/Santiago': 'CL', 'America/Lima': 'PE', 'America/Caracas': 'VE', 'Atlantic/Canary': 'ES', 'Asia/Kathmandu': 'NP'
  };

  // ---- pure helpers --------------------------------------------------------------------------------------------------
  // lower case, no accents/diacritics, a few letters that have no decomposition; Devanagari, Arabic, Cyrillic and Greek are kept as typed
  function normalize(s) {
    var out = String(s == null ? '' : s).toLowerCase();
    try { out = out.normalize('NFD'); } catch (e) { /* very old browser */ }
    out = out.replace(/[̀-ͯ]/g, '');
    return out.replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/đ/g, 'd').replace(/ı/g, 'i')
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  function codesOf(supported) { return supported.map(function (l) { return l[0]; }); }

  /** Languages recommended after English for a country (only codes that are supported). */
  function recommend(country, supported) {
    var c = String(country || '').toUpperCase(), ok = codesOf(supported), list = null;
    if (Object.prototype.hasOwnProperty.call(COUNTRY, c)) list = COUNTRY[c];
    else for (var i = 0; i < REGIONS.length && !list; i++) if (REGIONS[i].countries.split(' ').indexOf(c) >= 0) list = REGIONS[i].langs;
    return (list || []).filter(function (x) { return ok.indexOf(x) >= 0 && x !== 'en'; });
  }

  /** The full supported list: English, then the recommended languages (country first, then the browser's language), then everything else in the default order. */
  function order(supported, country, browserLangs) {
    var ok = codesOf(supported), first = ['en'];
    recommend(country, supported).forEach(function (x) { if (first.indexOf(x) < 0) first.push(x); });
    (browserLangs || []).forEach(function (b) {
      var base = String(b || '').toLowerCase().split('-')[0];
      if (base === 'no') base = 'nb';
      if (ok.indexOf(base) >= 0 && first.indexOf(base) < 0) first.push(base);
    });
    var byCode = {}; supported.forEach(function (l) { byCode[l[0]] = l; });
    var out = first.filter(function (x) { return byCode[x]; }).map(function (x) { return byCode[x]; });
    supported.forEach(function (l) { if (first.indexOf(l[0]) < 0) out.push(l); });
    return { all: out, recommended: first.filter(function (x) { return byCode[x]; }).length };
  }

  /** Search the whole supported list by native name, English name or alias (accent and case insensitive). Best match first. */
  function search(query, supported) {
    var q = normalize(query);
    if (!q) return null;
    var res = [];
    supported.forEach(function (l, pos) {
      var terms = [l[1]].concat(NAMES[l[0]] || [], [l[0]]).map(normalize).filter(Boolean), best = 0;
      terms.forEach(function (t) {
        var s = 0;
        if (t === q) s = 100;
        else if (t.indexOf(q) === 0) s = 80;
        else if (t.split(' ').some(function (w) { return w.indexOf(q) === 0; })) s = 60;
        else if (q.length >= 2 && t.indexOf(q) > 0) s = 40;
        if (s > best) best = s;
      });
      if (best) res.push({ l: l, s: best, pos: pos });
    });
    res.sort(function (a, b) { return b.s - a.s || a.pos - b.pos; });
    return res.map(function (r) { return r.l; });
  }

  /** Country from a time zone name, or '' */
  function countryFromTimeZone(tz) { return TZ[tz] || ''; }
  /** Country from browser language tags such as "de-CH", or '' */
  function countryFromLanguages(langs) {
    for (var i = 0; i < (langs || []).length; i++) { var m = /^[a-z]{2,3}-([A-Za-z]{2})\b/.exec(String(langs[i])); if (m) return m[1].toUpperCase(); }
    return '';
  }
  /** Country from the text answer of Cloudflare's /cdn-cgi/trace ("loc=IN"), or '' (no other line, such as the IP address, is read) */
  function countryFromTrace(text) { var m = /^loc=([A-Z]{2})$/m.exec(String(text || '')); return m && m[1] !== 'XX' && m[1] !== 'T1' ? m[1] : ''; }

  return { NAMES: NAMES, COUNTRY: COUNTRY, REGIONS: REGIONS, TZ: TZ, normalize: normalize, recommend: recommend, order: order, search: search,
    countryFromTimeZone: countryFromTimeZone, countryFromLanguages: countryFromLanguages, countryFromTrace: countryFromTrace };
});
