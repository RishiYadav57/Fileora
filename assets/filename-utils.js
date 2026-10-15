/* Shared file-name rules for the results page (renaming) and the server (Content-Disposition).
 * A rename only changes the name offered for download; stored files and their contents are never touched. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FilenameUtils = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var MAX_BASE_LENGTH = 100;
  var INVALID = /[\u0000-\u001f\u007f\\\/:*?"<>|]/;
  var RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

  // "report.final.pptx" -> { base: "report.final", ext: ".pptx" }; "notes" -> { base: "notes", ext: "" }
  function splitName(name) {
    var s = String(name == null ? '' : name);
    var i = s.lastIndexOf('.');
    if (i <= 0 || i === s.length - 1 || s.length - i > 9 || /\s/.test(s.slice(i))) return { base: s, ext: '' };
    return { base: s.slice(0, i), ext: s.slice(i) };
  }

  // Validates what the user typed (without the extension). Returns { ok, base, name } or { ok:false, error }.
  function validateBase(raw, ext) {
    ext = ext || '';
    var v = String(raw == null ? '' : raw);
    if (v.normalize) v = v.normalize('NFC');
    if (!v.trim()) return { ok: false, error: 'Enter a file name.' };
    if (INVALID.test(v)) return { ok: false, error: 'File names cannot contain \\ / : * ? " < > | or control characters.' };
    v = v.trim().replace(/\s+/g, ' ');
    while (ext && v.length > ext.length && v.toLowerCase().slice(-ext.length) === ext.toLowerCase()) v = v.slice(0, -ext.length).trim(); // never "x.pptx.pptx"
    v = v.replace(/[. ]+$/, '');
    if (!v) return { ok: false, error: 'Enter a file name.' };
    if (v.charAt(0) === '.') return { ok: false, error: 'File names cannot start with a dot.' };
    if (RESERVED.test(v)) return { ok: false, error: 'That name is reserved by Windows. Please choose another.' };
    if (Array.from(v).length > MAX_BASE_LENGTH) return { ok: false, error: 'File names can be at most ' + MAX_BASE_LENGTH + ' characters.' };
    return { ok: true, base: v, name: v + ext };
  }

  // Server side: a requested download name, forced to keep the stored file's extension; falls back to the stored name.
  function safeDownloadName(requested, stored) {
    var ext = splitName(stored).ext;
    var r = validateBase(requested, ext);
    return r.ok ? r.name : String(stored || 'download');
  }

  // Content-Disposition value: ASCII fallback + RFC 5987 UTF-8 name.
  function contentDisposition(name) {
    var ascii = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    var utf8 = encodeURIComponent(name).replace(/['()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); });
    return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + utf8;
  }

  return { MAX_BASE_LENGTH: MAX_BASE_LENGTH, splitName: splitName, validateBase: validateBase, safeDownloadName: safeDownloadName, contentDisposition: contentDisposition };
});
