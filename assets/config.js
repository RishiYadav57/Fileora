/* Single place that defines where the FileCorner API lives. Loaded synchronously (it is tiny) by every public page before
 * any other script; the converter, the download page and the warm-up all read FILEORA_CONFIG instead of hardcoding a URL.
 * Contains no credentials. */
(function () {
  'use strict';
  var CLOUD = 'https://docgrid-project.onrender.com';   // production backend (Render)
  var LOCAL = 'http://localhost:3000';                   // only used when the page is opened as a file:// document
  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || location.protocol === 'file:';
  var cloudHost = CLOUD.replace(/^https?:\/\//, '');

  // Base URL for API calls ('' means "same origin as this page").
  function apiBase() {
    if (location.protocol === 'file:') return LOCAL;
    if (isLocal) return '';                              // local dev server serves both the pages and the API
    if (location.host === cloudHost) return '';          // pages served by the backend itself
    return CLOUD;                                        // static hosting (e.g. Netlify): API lives on Render
  }

  window.FILEORA_CONFIG = {
    cloudBackend: CLOUD,
    localBackend: LOCAL,
    isLocal: isLocal,
    apiBase: apiBase,
    /* absolute backend origin for this page */
    backend: function () { var b = apiBase(); return b || location.origin; }
  };
})();
