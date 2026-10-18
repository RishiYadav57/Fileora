/* FileCorner tool search: internal metadata + matcher. Used only for matching what a visitor types in "Search tools..." - none of this text is
 * ever shown on a page (the dropdown shows the official tool name, icon, category and formats as before).
 * One entry per tool, keyed by the id in the tool registry of index.html (tests/test-search.js checks both lists stay identical).
 * Every entry describes only what the tool really does; nothing here may promise OCR, password guessing, perfect formatting, etc.
 * fileTypes use canonical codes: pdf, docx, pptx, xlsx (also csv), jpg (also jpeg), png, webp, zip, txt. */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FileCornerSearch = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var T = {
    'merge-pdf': { name: 'Merge PDF', description: 'Combine several PDF files into one PDF document, in the order you choose.',
      synonyms: ['combine pdf', 'join pdf', 'pdf merger', 'pdf joiner', 'append pdf', 'concatenate pdf'],
      keywords: ['merge pdf files', 'put pdfs together', 'join pdf files into one', 'combine documents into one pdf', 'merge multiple pdfs', 'unite pdf'],
      examples: ['combine pdf files', 'join two pdfs', 'merge documents', 'merge pdfs into one'], fileTypes: { pair: false, in: ['pdf'], out: ['pdf'] } },
    'split-pdf': { name: 'Split PDF', description: 'Separate a PDF into single-page files or into the page ranges you enter, delivered as a ZIP.',
      synonyms: ['pdf splitter', 'divide pdf', 'separate pdf pages', 'break pdf apart', 'cut pdf'],
      keywords: ['split pdf pages', 'split pdf by page range', 'one page per file', 'separate pdf into files', 'split large pdf', 'pdf page separator'],
      examples: ['split pdf pages', 'separate pdf into files', 'divide a pdf in two', 'split pdf by range'], fileTypes: { pair: false, in: ['pdf'], out: ['pdf', 'zip'] } },
    'remove-pages': { name: 'Remove pages', description: 'Delete the pages you select from a PDF and download the rest as a new PDF.',
      synonyms: ['delete pdf pages', 'remove pdf pages', 'pdf page remover', 'drop pages from pdf'],
      keywords: ['delete pages from pdf', 'remove page from pdf', 'get rid of pdf pages', 'cut pages out of pdf', 'get rid of empty pages', 'take unwanted pages out'],
      examples: ['remove pages from pdf', 'delete a page in pdf', 'delete pdf pages'], fileTypes: { pair: false, in: ['pdf'], out: ['pdf'] } },
    'extract-pages': { name: 'Extract pages', description: 'Pull selected pages out of a PDF into a new PDF that contains only those pages.',
      synonyms: ['pdf page extractor', 'extract pdf pages', 'select pdf pages', 'save selected pdf pages'],
      keywords: ['extract pages from pdf', 'get pages from pdf', 'pull pages out of pdf', 'keep only some pages', 'copy pages to new pdf', 'take pages from pdf'],
      examples: ['extract pages from pdf', 'save page 3 of a pdf', 'get some pages from a pdf'], fileTypes: { pair: false, in: ['pdf'], out: ['pdf'] } },
    'organize-pdf': { name: 'Customize PDF', description: 'See every PDF page as a thumbnail, then drag to reorder, rotate or delete pages and save the result.',
      synonyms: ['organize pdf', 'rearrange pdf', 'reorder pdf pages', 'rotate pdf', 'pdf page organizer', 'sort pdf pages', 'pdf page manager'],
      keywords: ['change pdf page order', 'rearrange pages in pdf', 'rotate pdf pages', 'fix sideways pdf', 'turn pdf pages', 'flip pdf page', 'move pdf pages', 'organise pdf', 'manage pdf pages'],
      examples: ['rearrange pages', 'change pdf page order', 'rotate a pdf', 'reorder pdf pages'], fileTypes: { pair: false, in: ['pdf'], out: ['pdf'] } },
    'compress-pdf': { name: 'Compress PDF', description: 'Reduce the file size of a PDF with light, recommended or strong compression.',
      synonyms: ['pdf compressor', 'shrink pdf', 'reduce pdf size', 'pdf size reducer', 'make pdf smaller', 'optimize pdf'],
      keywords: ['compress large pdf', 'make pdf file smaller', 'pdf too big', 'pdf under 1mb', 'lower pdf file size', 'reduce pdf file size for email', 'minimize pdf'],
      examples: ['make pdf smaller', 'reduce pdf size', 'compress large pdf', 'shrink a pdf for email'], fileTypes: { pair: false, in: ['pdf'], out: ['pdf'] } },
    'repair-pdf': { name: 'Repair PDF', description: 'Rebuild a damaged or corrupt PDF so it can be opened again, where the file can be recovered.',
      synonyms: ['pdf repair', 'fix pdf', 'recover pdf', 'pdf fixer', 'restore pdf'],
      keywords: ['corrupt pdf', 'damaged pdf', 'broken pdf', 'pdf will not open', 'pdf cannot open', 'fix corrupted pdf', 'repair broken pdf file'],
      examples: ['fix a corrupt pdf', 'pdf wont open', 'repair damaged pdf', 'recover broken pdf'], fileTypes: { pair: false, in: ['pdf'], out: ['pdf'] } },
    'compress-image': { name: 'Compress Image', description: 'Make JPG, PNG and WebP images smaller; choose quality, size or target file size, and the output format JPEG, WebP or PNG.',
      synonyms: ['image compressor', 'photo compressor', 'reduce image size', 'shrink image', 'picture compressor', 'compress jpg', 'compress png', 'image converter'],
      keywords: ['make photo smaller', 'reduce photo file size', 'image size reducer', 'compress photos for email', 'resize image file size', 'png to jpg', 'jpg to png', 'jpeg to webp', 'change image format', 'convert image format', 'compress webp'],
      examples: ['reduce image size', 'compress jpg', 'png to jpg', 'make a photo smaller', 'convert png to jpeg'], fileTypes: { in: ['jpg', 'png', 'webp'], out: ['jpg', 'png', 'webp'] } },
    'word-to-pdf': { name: 'WORD to PDF', description: 'Convert a Word (.docx) document into a PDF that keeps its pages, fonts and layout.',
      synonyms: ['docx to pdf', 'word to pdf converter', 'save word as pdf', 'word pdf converter', 'word document to pdf', 'microsoft word to pdf'],
      keywords: ['convert word to pdf', 'convert docx to pdf', 'make a pdf from word', 'export word as pdf', 'word file to pdf'],
      examples: ['save word as pdf', 'convert docx to pdf', 'word document to pdf', 'docx to pdf'], fileTypes: { in: ['docx'], out: ['pdf'] } },
    'powerpoint-to-pdf': { name: 'POWERPOINT to PDF', description: 'Convert a PowerPoint (.pptx) presentation into a PDF with one page per slide.',
      synonyms: ['pptx to pdf', 'powerpoint pdf converter', 'ppt to pdf', 'slides to pdf', 'presentation to pdf', 'save powerpoint as pdf'],
      keywords: ['convert powerpoint to pdf', 'convert pptx to pdf', 'export slides as pdf', 'make a pdf from a presentation', 'powerpoint file to pdf'],
      examples: ['pptx to pdf', 'convert presentation to pdf', 'save slides as pdf'], fileTypes: { in: ['pptx'], out: ['pdf'] } },
    'excel-to-pdf': { name: 'EXCEL to PDF', description: 'Convert an Excel workbook (.xlsx) or a CSV file into a formatted PDF.',
      synonyms: ['xlsx to pdf', 'excel pdf converter', 'xls to pdf', 'spreadsheet to pdf', 'csv to pdf', 'save excel as pdf'],
      keywords: ['convert excel to pdf', 'convert xlsx to pdf', 'convert csv to pdf', 'make a pdf from a spreadsheet', 'export spreadsheet as pdf', 'excel sheet to pdf', 'table to pdf'],
      examples: ['xlsx to pdf', 'convert spreadsheet to pdf', 'csv to pdf', 'save excel as pdf'], fileTypes: { in: ['xlsx', 'csv'], out: ['pdf'] } },
    'jpg-to-pdf': { name: 'JPG to PDF', description: 'Turn JPG, JPEG, PNG and WebP images into a PDF document, one image per page.',
      synonyms: ['jpeg to pdf', 'image to pdf', 'photo to pdf', 'picture to pdf', 'png to pdf', 'images to pdf', 'photos to pdf'],
      keywords: ['convert jpg to pdf', 'convert image to pdf', 'make a pdf from photos', 'combine images into pdf', 'webp to pdf', 'scan to pdf from photo', 'pictures into pdf'],
      examples: ['jpeg to pdf', 'image to pdf', 'photos to pdf', 'png to pdf'], fileTypes: { in: ['jpg', 'png', 'webp'], out: ['pdf'] } },
    'pdf-to-powerpoint': { name: 'PDF to PPTX', description: 'Convert PDF pages into PowerPoint slides; text and tables stay editable and scanned pages are kept as pictures.',
      synonyms: ['pdf to powerpoint', 'pdf to ppt', 'pdf to slides', 'pdf presentation converter', 'pdf to presentation'],
      keywords: ['convert pdf to pptx', 'convert pdf to powerpoint', 'make slides from a pdf', 'turn pdf into a presentation', 'pdf to editable powerpoint'],
      examples: ['pdf to ppt', 'convert pdf to powerpoint', 'turn pdf into slides'], fileTypes: { in: ['pdf'], out: ['pptx'] } },
    'pdf-to-word': { name: 'PDF to WORD', description: 'Convert a PDF into an editable Word (.docx) document; scanned pages are kept as pictures.',
      synonyms: ['pdf to docx', 'pdf to doc', 'pdf word converter', 'pdf to word converter', 'pdf to word document'],
      keywords: ['convert pdf to word', 'convert pdf to docx', 'turn pdf into word document', 'edit a pdf in word', 'extract editable text from pdf', 'make pdf editable'],
      examples: ['convert pdf to docx', 'pdf to word converter', 'turn pdf into word document', 'edit pdf in word'], fileTypes: { in: ['pdf'], out: ['docx'] } },
    'powerpoint-to-word': { name: 'POWERPOINT to WORD', description: 'Convert a PowerPoint (.pptx) presentation into a Word document with one slide per page.',
      synonyms: ['pptx to word', 'ppt to word', 'pptx to docx', 'slides to word', 'presentation to word', 'powerpoint to docx'],
      keywords: ['convert powerpoint to word', 'convert pptx to docx', 'slides into a word document', 'presentation as word document', 'print slides in word'],
      examples: ['pptx to word', 'convert presentation to word', 'powerpoint to docx'], fileTypes: { in: ['pptx'], out: ['docx'] } },
    'word-to-powerpoint': { name: 'WORD to POWERPOINT', description: 'Convert a Word (.docx) document into PowerPoint slides.',
      synonyms: ['docx to pptx', 'word to ppt', 'word to pptx', 'word to slides', 'document to presentation', 'docx to powerpoint'],
      keywords: ['convert word to powerpoint', 'convert docx to pptx', 'make slides from a word document', 'word document into presentation'],
      examples: ['word to ppt', 'docx to powerpoint', 'make slides from word'], fileTypes: { in: ['docx'], out: ['pptx'] } },
    'pdf-to-excel': { name: 'PDF to EXCEL', description: 'Extract the tables in a PDF into an Excel (.xlsx) spreadsheet; scanned pages are not supported.',
      synonyms: ['pdf to xlsx', 'pdf to xls', 'pdf spreadsheet converter', 'pdf to spreadsheet', 'pdf table extractor', 'pdf to csv'],
      keywords: ['convert pdf to excel', 'convert pdf to xlsx', 'extract tables from pdf', 'pdf tables to excel', 'pull data out of a pdf table', 'pdf table to spreadsheet'],
      examples: ['extract tables from pdf', 'pdf to xlsx', 'convert pdf table to excel', 'pdf to spreadsheet'], fileTypes: { in: ['pdf'], out: ['xlsx'] } },
    'pdf-to-jpg': { name: 'PDF to JPG', description: 'Convert the pages of a PDF into high-resolution JPG images.',
      synonyms: ['pdf to jpeg', 'pdf to image', 'pdf to picture', 'pdf page to image', 'pdf to photo'],
      keywords: ['convert pdf to jpg', 'convert pdf to jpeg', 'save pdf pages as images', 'turn pdf pages into pictures', 'pdf to image converter', 'extract images from pdf pages'],
      examples: ['pdf to jpeg', 'convert pdf pages to images', 'save pdf as image'], fileTypes: { in: ['pdf'], out: ['jpg'] } },
    'unlock-pdf': { name: 'Unlock PDF', description: 'Remove owner restrictions (printing, copying, editing limits) from a PDF; a PDF that needs a password to open requires that password. Passwords are never guessed.',
      synonyms: ['pdf unlocker', 'pdf password remover', 'remove pdf password', 'remove pdf restrictions', 'unprotect pdf', 'decrypt pdf', 'pdf decryptor'],
      keywords: ['unlock protected pdf', 'remove password from pdf', 'remove pdf security', 'allow printing pdf', 'allow copy pdf', 'pdf permissions remover', 'open locked pdf', 'pdf editing restrictions'],
      examples: ['remove password from pdf', 'pdf password remover', 'unlock a protected pdf', 'decrypt pdf'], fileTypes: { pair: false, in: ['pdf'], out: ['pdf'] } },
    'protect-pdf': { name: 'Protect PDF', description: 'Encrypt a PDF with a password so it cannot be opened without it.',
      synonyms: ['password protect pdf', 'encrypt pdf', 'lock pdf', 'secure pdf', 'pdf encryption', 'pdf locker'],
      keywords: ['add password to pdf', 'put a password on pdf', 'protect pdf with password', 'make pdf secure', 'pdf password protection', 'set pdf password'],
      examples: ['add password to pdf', 'lock pdf', 'encrypt a pdf document', 'password protect a pdf'], fileTypes: { pair: false, in: ['pdf'], out: ['pdf'] } },
    'add-watermark': { name: 'Add Watermark', description: 'Stamp a text watermark across every page of a PDF.',
      synonyms: ['pdf watermark', 'watermark pdf', 'stamp pdf', 'pdf stamp', 'text watermark'],
      keywords: ['put watermark on pdf', 'add confidential stamp to pdf', 'add draft watermark', 'mark pdf pages with text', 'watermark every page'],
      examples: ['add watermark to pdf', 'stamp confidential on pdf', 'put draft on every page'], fileTypes: { pair: false, in: ['pdf'], out: ['pdf'] } },
    'zip-files': { name: 'ZIP Files', description: 'Package one or more files into a single ZIP archive.',
      synonyms: ['zip maker', 'create zip', 'zip creator', 'compress files into zip', 'make zip file', 'archive files'],
      keywords: ['zip multiple files', 'put files in a zip', 'compress folder to zip', 'bundle files together', 'create archive', 'zip documents'],
      examples: ['make a zip file', 'zip multiple files', 'create zip archive'], fileTypes: { in: ['pdf', 'docx', 'pptx', 'xlsx', 'jpg', 'png', 'webp', 'txt'], out: ['zip'] } },
    'unzip-files': { name: 'UNZIP Archive', description: 'Extract the files inside a ZIP archive.',
      synonyms: ['unzip', 'zip extractor', 'extract zip', 'open zip file', 'zip opener', 'zip unpacker', 'decompress zip'],
      keywords: ['unzip files online', 'extract files from zip', 'open a zip archive', 'unpack zip', 'unzip archive'],
      examples: ['unzip a file', 'extract zip', 'open zip file online'], fileTypes: { in: ['zip'], out: ['pdf', 'docx', 'pptx', 'xlsx', 'jpg', 'png', 'webp', 'txt'] } },
    'ai-summarizer': { name: 'AI Summarizer', description: 'Summarize a document or image into key points with AI; limited to one document per connection per day.',
      synonyms: ['document summarizer', 'pdf summarizer', 'summarize pdf', 'summary generator', 'ai summary', 'text summarizer'],
      keywords: ['summarize a document', 'summarise pdf', 'key points from pdf', 'tldr of a document', 'short summary of a file', 'summarize word document', 'summarize presentation', 'chatgpt pdf summary'],
      examples: ['summarize pdf', 'key points from a document', 'give me a summary of this file'], fileTypes: { pair: false, in: ['pdf', 'docx', 'pptx', 'txt', 'jpg', 'png', 'webp'], out: ['pdf'] } },
    'translate-pdf': { name: 'Translate Document', description: 'Translate the text of a PDF or text file into another language and download the translation as a PDF; limited to one document per connection per day.',
      synonyms: ['translate pdf', 'pdf translator', 'document translator', 'translate document', 'pdf language translator'],
      keywords: ['translate pdf to english', 'translate pdf to hindi', 'translate pdf to spanish', 'translate text file', 'change language of pdf', 'convert pdf language', 'translate a document online'],
      examples: ['translate pdf', 'translate document to english', 'pdf translator'], fileTypes: { pair: false, in: ['pdf', 'txt'], out: ['pdf'] } },
    'scan-pdf': { name: 'Scan PDF', description: 'Straighten scanned pages and add a searchable text layer (OCR); currently unavailable on the free server.',
      synonyms: ['ocr pdf', 'pdf ocr', 'make pdf searchable', 'searchable pdf', 'scan to text', 'deskew pdf'],
      keywords: ['ocr scanned pdf', 'recognize text in pdf', 'straighten scanned pages', 'make scanned pdf searchable', 'text recognition', 'pdf scanner'],
      examples: ['ocr pdf', 'make pdf searchable', 'scan pdf to text'], fileTypes: { pair: false, in: ['pdf'], out: ['pdf'] } },
    'enhance-image': { name: 'Enhance Image', description: 'Improve clarity, sharpness, contrast and colour balance of a photo with filters; currently unavailable on the free server.',
      synonyms: ['image enhancer', 'photo enhancer', 'sharpen image', 'improve image quality', 'photo sharpener', 'picture enhancer'],
      keywords: ['make photo clearer', 'increase image sharpness', 'improve photo quality', 'adjust contrast', 'brighten image', 'denoise photo', 'fix blurry image', 'enhance photo'],
      examples: ['sharpen image', 'improve photo quality', 'enhance a picture'], fileTypes: { pair: false, in: ['jpg', 'png', 'webp'], out: ['jpg', 'png', 'webp'] } }
  };

  // ------------------------------------------------------------------ matching
  var STOP = {}; 'to a an the my of from into in on for and or with online free file files document documents how can i you your please need want make get convert as by it this that just'.split(' ').forEach(function (w) { STOP[w] = 1; });
  var ALIAS = { jpeg: 'jpg', jpegs: 'jpg', jpgs: 'jpg', ppt: 'pptx', ppts: 'pptx', xls: 'xlsx', doc: 'docx', docs: 'docx', picture: 'image', pictures: 'image', photo: 'image', photos: 'image', img: 'image', images: 'image', spreadsheet: 'excel', spreadsheets: 'excel', slides: 'slide', presentation: 'powerpoint', presentations: 'powerpoint', summarise: 'summarize', organise: 'organize', encrypt: 'protect', decrypt: 'unlock', smaller: 'small', pdfs: 'pdf' };
  var FORMAT = { pdf: 'pdf', word: 'docx', docx: 'docx', doc: 'docx', powerpoint: 'pptx', pptx: 'pptx', ppt: 'pptx', slides: 'pptx', slide: 'pptx', presentation: 'pptx', excel: 'xlsx', xlsx: 'xlsx', xls: 'xlsx', csv: 'xlsx', spreadsheet: 'xlsx', jpg: 'jpg', jpeg: 'jpg', image: 'jpg', picture: 'jpg', photo: 'jpg', png: 'png', webp: 'webp', zip: 'zip', txt: 'txt', text: 'txt' };
  var GENERIC = { pdf: 1, image: 1 };

  function stem(w) {
    if (/\d/.test(w) || w.length <= 3) return w;
    var out = w;
    var suf = ['ing', 'ion', 'er', 'or', 'ed', 'es', 's'];
    for (var i = 0; i < suf.length; i++) {
      var s = suf[i];
      if (out.length - s.length >= 3 && out.slice(-s.length) === s && !(s === 's' && /ss$/.test(out))) { out = out.slice(0, -s.length); break; }
    }
    if (out.length > 3 && out.slice(-1) === 'e') out = out.slice(0, -1);
    if (out.length > 3 && /([bdgmnprt])\1$/.test(out)) out = out.slice(0, -1);
    return out;
  }
  function words(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(function (w) { return ALIAS[w] || w; });
  }
  function sig(text) { return words(text).filter(function (w) { return !STOP[w]; }).map(stem); }
  function phraseKey(text) { return sig(text).join(' '); }

  // damerau-free edit distance (insert/delete/substitute), small strings only
  function dist(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    var prev = [], prev2 = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);   // swapped neighbours count as one slip
      }
      prev2 = prev; prev = cur;
    }
    return prev[b.length];
  }

  var index = null;
  function build(names) {
    var vocab = {}, raw = {}, list = [];
    Object.keys(T).forEach(function (id) {
      var m = T[id], nm = (names && names[id]) || m.name;
      [].concat([nm], m.synonyms, m.keywords, m.examples, [m.description]).forEach(function (txt) { words(txt).forEach(function (w) { raw[w] = 1; }); });
      var phrases = [].concat(m.synonyms, m.keywords, m.examples).map(phraseKey).filter(Boolean);
      var e = { id: id, nameKey: phraseKey(nm), nameTokens: sig(nm), nameWords: words(nm), phrases: phrases, synTokens: {}, descTokens: {}, fileTokens: {}, all: {} };
      [].concat(m.synonyms, m.examples).forEach(function (p) { sig(p).forEach(function (t) { e.synTokens[t] = 1; }); });
      [].concat(m.keywords).forEach(function (p) { sig(p).forEach(function (t) { e.synTokens[t] = 1; }); });
      sig(m.description).forEach(function (t) { e.descTokens[t] = 1; });
      [].concat(m.fileTypes.in, m.fileTypes.out).forEach(function (f) { sig(f).forEach(function (t) { e.fileTokens[t] = 1; }); });
      e.nameTokens.forEach(function (t) { e.all[t] = 1; });
      ['synTokens', 'descTokens', 'fileTokens'].forEach(function (k) { Object.keys(e[k]).forEach(function (t) { e.all[t] = 1; }); });
      Object.keys(e.all).forEach(function (t) { vocab[t] = 1; });
      e.in = m.fileTypes.in; e.out = m.fileTypes.out; e.pairs = m.fileTypes.pair !== false;
      list.push(e);
    });
    return { list: list, vocab: Object.keys(vocab), raw: raw };
  }

  /** search(query[, order]) -> [{ id, score }] best first, one entry per tool. `order` (array of ids) breaks ties in registry order. */
  function search(query, order) {
    if (!index) index = build();
    var q = String(query || '').trim();
    if (q.length < 1) return [];
    var rawWords = words(q);
    // the word still being typed: a prefix of a known word ("pd", "pass", "compr") is matched as a prefix, never "repaired" into another word
    var lastTyped = rawWords.length && /[a-z0-9]$/i.test(q) ? String(q).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').pop() : '';
    var partial = '';
    var onlyWord = rawWords.length === 1;   // a lone "a" or "to" is the start of a word, not a filler word
    if (lastTyped && (STOP[lastTyped] ? onlyWord : !index.raw[lastTyped] && !index.raw[ALIAS[lastTyped]])) {
      var known = Object.keys(index.raw);
      for (var ki = 0; ki < known.length; ki++) if (known[ki].indexOf(lastTyped) === 0 || (lastTyped.length >= 3 && known[ki].indexOf(lastTyped) > 0)) { partial = lastTyped; break; }
    }
    // a finished word can still be the start of a longer one ("me" -> merge): its name / synonym prefix matches are added on top of the normal result
    var addPrefix = !partial && lastTyped && lastTyped.length <= 3 && !STOP[lastTyped] ? lastTyped : '';
    if (partial) rawWords = rawWords.slice(0, -1);   // the finished words are matched as before; the partial word is handled below
    rawWords = rawWords.map(function (w) {
      if (STOP[w] || w.length < 4 || index.raw[w]) return w;
      var best = null, bd = w.length > 6 ? 2 : 1;
      Object.keys(index.raw).forEach(function (v) { var d = dist(w, v); if (d <= bd && (best === null || d < bd)) { best = v; bd = d; } });
      return best || w;
    });
    var tokens = rawWords.filter(function (w) { return !STOP[w]; }).map(stem);
    if (!tokens.length && !partial) return [];
    // tolerate typos: a token the index has never seen is replaced by the closest known token (one edit; two for long words)
    var fixed = tokens.map(function (t) {
      if (index.vocab.indexOf(t) >= 0 || t.length < 4) return t;
      var best = null, bd = t.length > 6 ? 2 : 1;
      index.vocab.forEach(function (v) { var d = dist(t, v); if (d <= bd && (best === null || d < bd)) { best = v; bd = d; } });
      return best || t;
    });
    var qKey = fixed.join(' ');
    // "pdf to docx" style: the first and last format words are the source and the target
    var pair = null;
    var fw = rawWords.filter(function (w) { return FORMAT[w]; });
    if (rawWords.length >= 3 && /\b(to|2|into|as)\b/.test(q.toLowerCase().replace(/[^a-z0-9]+/g, ' ')) && fw.length >= 2) pair = { from: FORMAT[fw[0]], to: FORMAT[fw[fw.length - 1]] };
    else if (rawWords.length === 3 && rawWords[1] === 'to' && FORMAT[rawWords[0]] && FORMAT[rawWords[2]]) pair = { from: FORMAT[rawWords[0]], to: FORMAT[rawWords[2]] };

    var res = [];
    index.list.forEach(function (e, pos) {
      var score = 0, directional = false, viaName = false;   // viaName: the tool matched through its own name (not only a synonym / description)
      if (qKey === e.nameKey) { score = 100; viaName = true; }
      else if (e.nameKey.indexOf(qKey) >= 0 && qKey.length >= 3) { score = 85; viaName = true; }
      e.phrases.forEach(function (p) {
        var s = 0;
        if (p === qKey) s = 95;
        else if (qKey.length >= 5 && p.indexOf(qKey) >= 0) s = p.indexOf(qKey) === 0 ? 64 : 62;
        else if (p.split(' ').length >= 3 && (' ' + qKey + ' ').indexOf(' ' + p + ' ') >= 0) s = 80;
        if (s > score) score = s;
      });
      if (pair && e.pairs) {
        var inOk = e.in.indexOf(pair.from) >= 0, outOk = e.out.indexOf(pair.to) >= 0;
        if (inOk && outOk && pair.from !== pair.to) { score = Math.max(score, 90); directional = true; viaName = true; }
        else if (inOk && outOk) { score = Math.max(score, 60); }
      }
      // token coverage: every meaningful word of the query is known to the tool (one may be missing in long queries)
      var covered = 0, inName = 0, inSyn = 0, nonGenericHits = 0, nameSpecific = 0;
      fixed.forEach(function (t) {
        if (e.all[t]) { covered++; if (!GENERIC[t]) nonGenericHits++; if (e.nameTokens.indexOf(t) >= 0) { inName++; if (!GENERIC[t]) nameSpecific++; } else if (e.synTokens[t]) inSyn++; }
      });
      var need = fixed.length >= 4 ? Math.ceil(fixed.length * 0.75) : fixed.length;
      if (partial) score = 0;   // while a word is being typed the tool must match that word (and every finished word before it)
      if ((partial || addPrefix) && covered >= need - (addPrefix ? 1 : 0)) {
        var pw = partial || addPrefix;
        // prefix / substring match for the word being typed (names rank above synonyms, synonyms above descriptions)
        var ps = 0, k;
        var starts = function (map) { return Object.keys(map).some(function (t) { return t.indexOf(pw) === 0; }); };
        var within = function (map) { return pw.length >= 3 && Object.keys(map).some(function (t) { return t.indexOf(pw) > 0; }); };
        var nm = {}; e.nameTokens.forEach(function (t) { nm[t] = 1; }); e.nameWords.forEach(function (t) { nm[t] = 1; });   // the name as written ("Zip Files" keeps "files")
        var nameHit = false;
        if (e.nameKey.indexOf(pw) === 0) { ps = 82; nameHit = true; }
        else if (starts(nm)) { ps = 78; nameHit = true; }
        else if (within(nm)) { ps = 58; nameHit = true; }
        else if (starts(e.synTokens)) ps = 56;
        else if (starts(e.fileTokens)) ps = 50;
        else if (within(e.synTokens)) ps = 46;
        else if (starts(e.descTokens)) ps = 40;
        else if (e.phrases.some(function (ph) { return ph.indexOf(pw) >= 0; })) ps = 38;
        if (partial && ps && fixed.length) ps = Math.min(ps, 40 + 25 * covered / (fixed.length + 1) + 10 * inName);   // finished words that also match keep the tool on top
        if (addPrefix && ps < 56) ps = 0;
        if (ps && nameHit) viaName = true;
        if (ps > score) score = ps;
      }
      if (!partial && covered >= need && covered > 0) {
        var onlyGeneric = nonGenericHits === 0;
        var s2 = 30 + 25 * (covered / fixed.length) + 6 * inName + 3 * inSyn;
        if (onlyGeneric && !inName && !inSyn) s2 = 20;          // "pdf" alone must come from a name / synonym, not from a description
        if (!inName && !inSyn) s2 = Math.min(s2, 44);            // description-only matches stay weak
        if (nameSpecific || (inName && !fixed.some(function (t) { return !GENERIC[t]; }))) viaName = true;   // a generic word such as "pdf" only counts when it is all that was typed
        if (s2 > score) score = s2;
      }
      if (score) res.push({ id: e.id, score: score, directional: directional, nameMatch: viaName, pos: order ? (order.indexOf(e.id) < 0 ? 999 : order.indexOf(e.id)) : pos });
    });
    if (pair && res.some(function (r) { return r.directional; })) res = res.filter(function (r) { return r.directional; });   // direction matters: PDF to JPG is not JPG to PDF
    res.sort(function (a, b) { return b.score - a.score || a.pos - b.pos; });
    var best = res.length ? res[0].score : 0;
    var floor = best >= 90 ? 0.7 : 0.45;
    return res.filter(function (r) { return r.score >= 35 && r.score >= best * floor; }).slice(0, 8).map(function (r) { return { id: r.id, score: Math.round(r.score), nameMatch: r.nameMatch }; });
  }

  return { tools: T, search: search, _stem: stem, _words: words };
});
