const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');
const converterEngine = require('./converter-engine');
const SEO_DATA = require('./seo-data.js');

const jobgate = require('./jobgate');
const filenameUtils = require('./assets/filename-utils.js');
// Child processes are tied to the request that started them (killed on cancel/timeout, bounded by the shared gate)
const execFileP = jobgate.execFileTracked;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Load environment variables from .env if present (zero-dependency)
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (process.env.FILEORA_SKIP_DOTENV !== 'true' && fs.existsSync(envPath)) { // FILEORA_SKIP_DOTENV: test hook, keeps tests away from real credentials
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      });
    } catch (e) {
      console.warn('Could not read .env file:', e.message);
    }
  }
})();

const r2Storage = require('./storage');
const security = require('./security');
const mailer = require('./mailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for Vercel deployment (expose size headers used by Compress PDF)
app.use(cors({ origin: '*', exposedHeaders: ['X-Original-Size', 'X-Result-Size', 'X-Target-Met', 'X-Converter-Fallback'] }));

// General IP-based rate limiting (120 req/min)
// Per-IP rate limit for API calls only: page and asset requests (one page view is ~20 of them) must not eat the budget
app.use('/api', security.rateLimiter(false));
app.use('/api', security.rejectOversizedRequest);

// Express JSON body limit for text / table payloads
app.use(express.json({ limit: '5mb' })); // text/table payloads only (client sends <= ~400 KB of text); file uploads are limited separately

// ---------------------------------------------------------------------
// Static assets + HTTP caching
//  - Only an explicit list of public files is served (never the project root: server code, logs, .env).
//  - Local asset URLs in HTML are rewritten to carry a content hash (?v=<sha1>), so a new deploy changes the URL.
//    Hash-versioned requests are cached for a year (immutable); everything else revalidates (ETag/Last-Modified).
//  - HTML always revalidates. Uploads, conversion results and downloads are never cached (see /api no-store below).
// ---------------------------------------------------------------------
const crypto = require('crypto');
const PUBLIC_ROOT_FILES = new Set(['converter-engine.js', 'seo-data.js']);
const ASSETS_DIR = path.join(__dirname, 'assets');
const assetHashCache = new Map(); // absolute path -> { mtimeMs, size, hash }

function assetHash(absPath) {
  try {
    const st = fs.statSync(absPath);
    const hit = assetHashCache.get(absPath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.hash;
    const hash = crypto.createHash('sha1').update(fs.readFileSync(absPath)).digest('hex').slice(0, 10);
    assetHashCache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, hash });
    return hash;
  } catch (e) { return null; }
}

// Maps a public URL path (/assets/x.png, /converter-engine.js) to a file on disk, or null if not a public asset
function resolvePublicAsset(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch (e) { return null; }
  if (decoded.includes('..') || decoded.includes('\0')) return null;
  const clean = decoded.replace(/^\/tools(?=\/assets\/)/, '');
  if (clean.startsWith('/assets/')) {
    const abs = path.join(ASSETS_DIR, clean.slice('/assets/'.length));
    return abs.startsWith(ASSETS_DIR + path.sep) ? abs : null;
  }
  const name = clean.slice(1);
  return PUBLIC_ROOT_FILES.has(name) ? path.join(__dirname, name) : null;
}

// Adds ?v=<hash> to every local asset URL found in an HTML string (markup, inline CSS and JS strings alike)
function versionAssetUrls(html) {
  return html.replace(/(\/assets\/[A-Za-z0-9._%\- ]+\.(?:png|jpe?g|webp|svg|ico|css|js|woff2?)|\/(?:converter-engine|seo-data)\.js)(?![A-Za-z0-9._%?])/g, (m) => {
    const abs = resolvePublicAsset(m);
    const h = abs && assetHash(abs);
    if (!h) return m;
    return m + '?v=' + h;
  });
}

const HTML_CACHE_CONTROL = 'no-cache'; // may be stored, but must be revalidated (ETag) on every visit
function sendHtml(res, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', HTML_CACHE_CONTROL);
  res.send(versionAssetUrls(html));
}
function sendHtmlFile(res, file) {
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) return res.status(404).send('Not found');
    sendHtml(res, html);
  });
}

function staticAssetHandler(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const abs = resolvePublicAsset(req.path);
  if (!abs) return next();
  const versioned = typeof req.query.v === 'string' && /^[a-f0-9]{10}$/.test(req.query.v);
  const opts = {
    dotfiles: 'deny',
    etag: true,
    lastModified: true,
    headers: {
      'Cache-Control': versioned
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate'
    }
  };
  res.sendFile(abs, opts, (err) => { if (err && !res.headersSent) next(); });
}
app.use(staticAssetHandler);

// Conversion, upload and download API responses can contain user data or signed links: never stored by browsers/proxies
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Serve front-end and informational pages
app.get('/', (req, res) => sendHtmlFile(res, path.join(__dirname, 'index.html')));
app.get('/download', (req, res) => sendHtmlFile(res, path.join(__dirname, 'download.html')));
app.get('/about', (req, res) => sendHtmlFile(res, path.join(__dirname, 'about.html')));
app.get('/faq', (req, res) => sendHtmlFile(res, path.join(__dirname, 'faq.html')));
app.get('/contact', (req, res) => sendHtmlFile(res, path.join(__dirname, 'contact.html')));
app.get('/privacy-policy', (req, res) => sendHtmlFile(res, path.join(__dirname, 'privacy-policy.html')));
app.get('/privacy', (req, res) => res.redirect(301, '/privacy-policy'));
app.get('/terms', (req, res) => sendHtmlFile(res, path.join(__dirname, 'terms.html')));
app.get('/cookie-policy', (req, res) => sendHtmlFile(res, path.join(__dirname, 'cookie-policy.html')));
app.get('/disclaimer', (req, res) => sendHtmlFile(res, path.join(__dirname, 'disclaimer.html')));
app.get('/file-retention', (req, res) => sendHtmlFile(res, path.join(__dirname, 'file-retention.html')));
app.get('/security', (req, res) => res.redirect(301, '/file-retention'));
app.get('/troubleshooting', (req, res) => sendHtmlFile(res, path.join(__dirname, 'troubleshooting.html')));
app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml');
  res.sendFile(path.join(__dirname, 'sitemap.xml'));
});
app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.sendFile(path.join(__dirname, 'robots.txt'));
});

// ---------------------------------------------------------------------
// Server-Side Pre-Rendering for 27 Tool Clean Routes & Technical SEO
// ---------------------------------------------------------------------
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderToolPage(toolId, req, res) {
  const tool = SEO_DATA[toolId];
  if (!tool) {
    const p404 = path.join(__dirname, '404.html');
    return res.status(404).sendFile(fs.existsSync(p404) ? p404 : path.join(__dirname, 'index.html'));
  }

  const indexPath = path.join(__dirname, 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) {
      return res.status(500).send('Error loading page');
    }

    // 1. Unique Page Title
    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(tool.title)}</title>`);

    // 2. Meta description
    html = html.replace(/<meta\s+name=["']description["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
      `<meta name="description" content="${escapeHtml(tool.metaDescription)}">`);

    // 3. Canonical link
    html = html.replace(/<link\s+rel=["']canonical["']\s+href=["'][\s\S]*?["']\s*\/?>/i,
      `<link rel="canonical" href="${tool.canonical}">`);

    // 4. Open Graph tags
    html = html.replace(/<meta\s+property=["']og:title["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
      `<meta property="og:title" content="${escapeHtml(tool.title)}">`);
    html = html.replace(/<meta\s+property=["']og:description["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
      `<meta property="og:description" content="${escapeHtml(tool.metaDescription)}">`);
    html = html.replace(/<meta\s+property=["']og:url["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
      `<meta property="og:url" content="${tool.canonical}">`);

    // 5. Twitter card tags
    html = html.replace(/<meta\s+name=["']twitter:title["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
      `<meta name="twitter:title" content="${escapeHtml(tool.title)}">`);
    html = html.replace(/<meta\s+name=["']twitter:description["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
      `<meta name="twitter:description" content="${escapeHtml(tool.metaDescription)}">`);
    html = html.replace(/<meta\s+name=["']twitter:url["']\s+content=["'][\s\S]*?["']\s*\/?>/i,
      `<meta name="twitter:url" content="${tool.canonical}">`);

    // 6. JSON-LD structured data (WebApplication, BreadcrumbList, FAQPage)
    const jsonLd = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebApplication",
          "@id": `${tool.canonical}#app`,
          "url": tool.canonical,
          "name": tool.name || tool.h1,
          "description": tool.metaDescription,
          "applicationCategory": "BusinessApplication",
          "operatingSystem": "All modern browsers (Chrome, Edge, Firefox, Safari)",
          "offers": {
            "@type": "Offer",
            "price": "0",
            "priceCurrency": "USD"
          }
        },
        {
          "@type": "BreadcrumbList",
          "@id": `${tool.canonical}#breadcrumb`,
          "itemListElement": [
            {
              "@type": "ListItem",
              "position": 1,
              "name": "Home",
              "item": "https://pdfconverterfree.in/"
            },
            {
              "@type": "ListItem",
              "position": 2,
              "name": tool.name || tool.h1,
              "item": tool.canonical
            }
          ]
        },
        {
          "@type": "FAQPage",
          "@id": `${tool.canonical}#faq`,
          "mainEntity": (tool.faqs || []).map(f => ({
            "@type": "Question",
            "name": f.q,
            "acceptedAnswer": {
              "@type": "Answer",
              "text": f.a
            }
          }))
        }
      ]
    };

    html = html.replace(/<script\s+id=["']seo-jsonld["']\s+type=["']application\/ld\+json["'][\s\S]*?<\/script>/i,
      `<script id="seo-jsonld" type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n</script>`);

    // 7. Pre-render Hero H1 and Subtitle in raw HTML
    const heroH1Rendered = tool.h1Html || escapeHtml(tool.h1);
    html = html.replace(/<h1 id=["']hero-main-h1["'][\s\S]*?<\/h1>/i,
      `<h1 id="hero-main-h1" class="text-2xl sm:text-3xl md:text-4xl font-black text-slate-950 dark:text-white tracking-tight leading-tight">${heroH1Rendered}</h1>`);
    html = html.replace(/<p id=["']hero-main-sub["'][\s\S]*?<\/p>/i,
      `<p id="hero-main-sub" class="text-xs sm:text-sm text-slate-600 dark:text-slate-300 mt-1 sm:mt-1.5 max-w-xl mx-auto leading-normal">${escapeHtml((tool.intro || '').split('\\n')[0])}</p>`);

    // 8. Bootstrap client script with current tool ID
    html = html.replace('</body>', `<script>window.INITIAL_TOOL_ID = "${toolId}";</script>\n</body>`);

    sendHtml(res, html);
  });
}

// Known aliases for user convenience and backwards compatibility
const TOOL_ALIASES = {
  'pdf-to-ppt': 'pdf-to-powerpoint',
  'ppt-to-pdf': 'powerpoint-to-pdf',
  'ppt-to-word': 'powerpoint-to-word',
  'word-to-ppt': 'word-to-powerpoint',
  'rotate-pdf': 'organize-pdf',
  'xlsm-to-pdf': 'excel-to-pdf',
  'pdf-to-xlsm': 'pdf-to-excel'
};

// 1. Canonical /tools/:slug routes
app.get('/tools/:slug', (req, res) => {
  const rawSlug = (req.params.slug || '').toLowerCase();
  const canonicalSlug = TOOL_ALIASES[rawSlug] || rawSlug;
  if (TOOL_ALIASES[rawSlug]) {
    return res.redirect(301, `/tools/${canonicalSlug}`);
  }
  if (SEO_DATA[canonicalSlug]) {
    return renderToolPage(canonicalSlug, req, res);
  }
  const p404 = path.join(__dirname, '404.html');
  return res.status(404).sendFile(fs.existsSync(p404) ? p404 : path.join(__dirname, 'index.html'));
});

// /tools index redirect to homepage tools section
app.get('/tools', (req, res) => res.redirect(301, '/#all-tools'));

// 2. Legacy /tool/:slug routes -> 301 redirect to canonical /tools/:slug
app.get('/tool/:slug', (req, res) => {
  const rawSlug = (req.params.slug || '').toLowerCase();
  const canonicalSlug = TOOL_ALIASES[rawSlug] || rawSlug;
  if (SEO_DATA[canonicalSlug]) {
    return res.redirect(301, `/tools/${canonicalSlug}`);
  }
  const p404 = path.join(__dirname, '404.html');
  return res.status(404).sendFile(fs.existsSync(p404) ? p404 : path.join(__dirname, 'index.html'));
});

// 3. Legacy bare /:slug routes -> 301 redirect to canonical /tools/:slug (for all 27 tools and aliases)
const allToolSlugs = Array.from(new Set(Object.keys(SEO_DATA).concat(Object.keys(TOOL_ALIASES))));
allToolSlugs.forEach(slug => {
  const canonicalSlug = TOOL_ALIASES[slug] || slug;
  app.get(`/${slug}`, (req, res) => res.redirect(301, `/tools/${canonicalSlug}`));
});

// Contact submission backend endpoint with Gmail SMTP notifications
const contactLogFile = path.join(__dirname, 'contact_submissions.log');
app.post('/api/contact', async (req, res) => {
  const clientIp = req.headers['x-forwarded-for']
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : (req.socket ? req.socket.remoteAddress || '127.0.0.1' : '127.0.0.1');

  // 1. Sliding-window rate limit (Max 5 submissions per 10 minutes per IP)
  const rateCheck = mailer.checkContactRateLimit(clientIp);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: `Too many submissions from your connection. Please wait ${rateCheck.retryAfterSec || 60} seconds before trying again.`
    });
  }

  // 2. Strict input validation & sanitization
  const validation = mailer.validateSubmission(req.body);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  // 3. Dispatch notification email via Gmail SMTP
  try {
    const result = await mailer.sendContactEmail(validation.data);
    console.log(`[Contact] Email dispatched for Ref ${result.referenceId} to ${process.env.CONTACT_TO || 'admin'} (MessageId: ${result.messageId})`);

    // Append minimal operational audit entry (without storing full message text indefinitely)
    try {
      const auditEntry = {
        timestamp: result.timestamp,
        referenceId: result.referenceId,
        category: validation.data.category,
        status: 'dispatched_to_smtp'
      };
      fs.appendFileSync(contactLogFile, JSON.stringify(auditEntry) + '\n');
    } catch (logErr) {
      console.warn('[Contact] Non-critical log write error:', logErr.message);
    }

    return res.json({
      success: true,
      referenceId: result.referenceId,
      message: `Thank you for reaching out to Fileora. Your message has been received and routed to our support team (Ref: ${result.referenceId}). We will review your query promptly.`
    });
  } catch (err) {
    console.error('[Contact] SMTP delivery error:', err.message || err);

    if (err.message === 'SMTP_PASS_NOT_CONFIGURED') {
      return res.status(503).json({
        error: 'The notification service is temporarily undergoing maintenance. Please email pdfconverterfreebusiness@gmail.com directly.',
        fallbackEmail: 'pdfconverterfreebusiness@gmail.com'
      });
    }

    return res.status(502).json({
      error: 'We were unable to deliver your message via our email service at this moment. Please try again shortly or write directly to pdfconverterfreebusiness@gmail.com.',
      fallbackEmail: 'pdfconverterfreebusiness@gmail.com'
    });
  }
});

// Temporary upload / output directories (cross-platform compatible)
const uploadDir = path.join(os.tmpdir(), 'fileconverter-uploads');
const outDir = path.join(os.tmpdir(), 'fileconverter-out');
const loProfileDir = path.join(os.tmpdir(), 'fileconverter-lo-profile');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
if (!fs.existsSync(loProfileDir)) fs.mkdirSync(loProfileDir, { recursive: true });

const multerStorage = multer.diskStorage({
  // re-create on every upload: an OS temp sweep or cleanup job may have removed the folder while the server was running
  destination: (req, file, cb) => { try { fs.mkdirSync(uploadDir, { recursive: true }); cb(null, uploadDir); } catch (e) { cb(e); } },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const name = uniqueSuffix + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    (req.__uploadPaths = req.__uploadPaths || []).push(path.join(uploadDir, name)); // lets the job gate remove half-written uploads on cancel
    cb(null, name);
  }
});
const upload = multer({
  storage: multerStorage,
  limits: {
    fileSize: security.LIMITS.MAX_FILE_SIZE_BYTES + 1, // multer rejects when the size REACHES the limit, so +1 lets exactly 10,000,000 B through and still rejects 15,000,001 B
    files: security.LIMITS.MAX_FILES_PER_BATCH      // Up to 3 files
  }
});

// Upload middleware used by every heavy route: multer stores the file (size limits enforced), then the request enters the
// shared run queue. Arrays are accepted by Express, so a route can list `gatedUpload.single('file')` as one middleware.
// Cheap structural check of the stored upload, so a failed conversion of a damaged / wrong-type file is reported as such
// (HTTP 422 with a clear message) instead of a generic 500. It never blocks a file: if the converter still succeeds, the
// result is delivered as usual.
const EXPECTED_PART = { docx: 'word/document.xml', pptx: 'ppt/presentation.xml' };
const INPUT_PROBLEM_TEXT = {
  damaged: 'This file appears to be damaged or incomplete, so it could not be converted. Try opening and re-saving it, then upload it again.',
  wrongtype: 'This file does not look like the type this tool expects, so it could not be converted. Please check that you chose the right tool.',
  legacy: 'Older Office formats (.doc, .ppt, .xls) are not fully supported by this tool. Please save the file in the newer format (.docx, .pptx, .xlsx) and try again.'
};
function inputGuard(kind) {
  return async (req, res, next) => {
    try {
      const f = req.file && req.file.path;
      if (f) {
        const head = Buffer.alloc(8); const fd = fs.openSync(f, 'r'); fs.readSync(fd, head, 0, 8, 0);
        const size = fs.fstatSync(fd).size; let tail = Buffer.alloc(0);
        if (kind === 'pdf') { tail = Buffer.alloc(Math.min(2048, size)); fs.readSync(fd, tail, 0, tail.length, size - tail.length); }
        fs.closeSync(fd);
        if (kind === 'pdf') {
          if (!tail.toString('latin1').includes('%%EOF')) req.__inputProblem = 'damaged';
        } else if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
          req.__inputProblem = 'legacy';
        } else if (kind === 'docx' || kind === 'pptx') {
          try {
            const zip = await require('jszip').loadAsync(fs.readFileSync(f));
            if (!zip.file('[Content_Types].xml')) req.__inputProblem = 'damaged';
            else if (!zip.file(EXPECTED_PART[kind])) req.__inputProblem = 'wrongtype';
          } catch (e) { req.__inputProblem = 'damaged'; }
        } else if (kind === 'office') {
          try { if (!(await require('jszip').loadAsync(fs.readFileSync(f))).file('[Content_Types].xml')) req.__inputProblem = 'damaged'; }
          catch (e) { if (!(head[0] === 0x50 ? false : /^[\x20-\x7e\r\n\t]*$/.test(head.toString('latin1')))) req.__inputProblem = 'damaged'; }
        }
      }
    } catch (e) { /* the guard only informs; never blocks */ }
    const origJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 500 && req.__inputProblem && body && body.error) {
        res.status(422);
        return origJson({ error: 'FILE_PROBLEM', reason: req.__inputProblem, message: INPUT_PROBLEM_TEXT[req.__inputProblem] });
      }
      return origJson(body);
    };
    next();
  };
}

const gatedUpload = {
  single: (name, kind) => (kind ? [upload.single(name), security.heavyGate, inputGuard(kind)] : [upload.single(name), security.heavyGate]),
  array: (name, max) => [upload.array(name, max), security.validateBatchSize, security.heavyGate]
};

// ---------------------------------------------------------------------
// Cloudflare R2 Temporary Storage & Job Retrieval Endpoints
// ---------------------------------------------------------------------

// 1. Get job metadata
app.get('/api/jobs/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const token = req.query.token;
    const auth = await r2Storage.getAuthorizedJob(jobId, token);

    if (auth.error) {
      return res.status(auth.status || 400).json({
        error: auth.error,
        message: auth.message
      });
    }

    res.json({
      jobId: auth.job.job_id,
      originalFilename: auth.job.original_filename,
      convertedFilename: auth.job.converted_filename,
      mimeType: auth.job.mime_type,
      fileSize: auth.job.file_size,
      status: auth.job.status,
      createdAt: auth.job.created_at,
      expiresAt: auth.job.expires_at
    });
  } catch (err) {
    console.error('[API /api/jobs/:jobId] Unexpected error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to retrieve job information.' });
  }
});

// 2. Download converted file stream from Cloudflare R2
app.get('/api/jobs/:jobId/download', async (req, res) => {
  try {
    const { jobId } = req.params;
    const token = req.query.token;
    const result = await r2Storage.getJobDownloadStream(jobId, token);

    if (result.error) {
      return res.status(result.status || 400).json({
        error: result.error,
        message: result.message
      });
    }

    const job = result.job;
    // Optional ?name= lets the results page offer a renamed download. Only the offered name changes: the stored
    // file and its R2 metadata stay as they are, the extension is forced to the stored one, and unsafe names fall back.
    const downloadName = typeof req.query.name === 'string' && req.query.name
      ? filenameUtils.safeDownloadName(req.query.name, job.converted_filename)
      : job.converted_filename;

    res.setHeader('Content-Type', job.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', job.file_size);
    res.setHeader('Content-Disposition', filenameUtils.contentDisposition(downloadName));
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

    result.stream.pipe(res);
  } catch (err) {
    console.error('[API /api/jobs/:jobId/download] Streaming error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'DOWNLOAD_FAILED', message: 'Failed to stream converted file from storage.' });
    }
  }
});

// 3. Client upload endpoint to store client-side converted files in R2
app.post('/api/jobs/upload', security.concurrencyLimiter, gatedUpload.single('file'), async (req, res) => {
  if (!await validateUploadSafety(req, res, null)) return;

  try {
    const originalName = req.file.originalname;
    const convertedName = req.body.filename || originalName;
    const job = await r2Storage.saveConvertedJob({
      filePathOrBuffer: req.file.path,
      originalFilename: originalName,
      convertedFilename: convertedName,
      mimeType: r2Storage.getMimeType(convertedName)
    });

    safeUnlink(req.file.path);

    res.json({
      success: true,
      jobId: job.jobId,
      downloadToken: job.downloadToken,
      downloadUrl: job.downloadUrl,
      apiUrl: job.apiUrl,
      filename: job.filename,
      size: job.size
    });
  } catch (err) {
    safeUnlink(req.file.path);
    console.error('[API /api/jobs/upload] Error uploading to storage:', err);
    res.status(500).json({ error: 'UPLOAD_FAILED', message: 'Failed to upload converted file to storage.' });
  }
});

// 4. Delete job and purge from storage
app.delete('/api/jobs/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const token = req.query.token;
    const result = await r2Storage.deleteJob(jobId, token);
    if (result.error) {
      return res.status(result.status || 400).json({ error: result.error, message: result.message });
    }
    res.json({ success: true, message: 'File has been deleted from cloud storage.' });
  } catch (err) {
    console.error('[API DELETE /api/jobs/:jobId] Error:', err);
    res.status(500).json({ error: 'DELETE_FAILED', message: 'Failed to delete file from storage.' });
  }
});

// 5. Trigger automated multi-phase cleanup (for Cloudflare Worker Cron Trigger, Netlify, or local cron)
app.post('/api/admin/cleanup', async (req, res) => {
  const adminSecret = r2Storage.CLEANUP_ADMIN_SECRET;
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.query.secret || '');

  const clientIp = req.socket ? req.socket.remoteAddress || '' : '';
  const isLoopback = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';

  if (adminSecret) {
    if (token !== adminSecret) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid administrative cleanup secret.' });
    }
  } else if (!isLoopback) {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Administrative cleanup requires CLEANUP_ADMIN_SECRET in .env for non-local requests.'
    });
  }

  try {
    const report = await r2Storage.runFullCleanup([uploadDir, outDir, loProfileDir]);
    res.json(report);
  } catch (err) {
    console.error('[API /api/admin/cleanup] Error:', err);
    res.status(500).json({ error: 'CLEANUP_FAILED', message: err.message });
  }
});

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.error('Error cleaning up:', err);
  }
}

function safeRmDir(dirPath) {
  try {
    if (dirPath && fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (err) {
    console.error('Error cleaning up folder:', err);
  }
}

function newOutPath(prefix, ext) {
  fs.mkdirSync(outDir, { recursive: true });
  return path.join(outDir, `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext || 'pdf'}`);
}

function isPdfFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(1024);
    fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    return buf.toString('latin1').includes('%PDF-');
  } catch (e) {
    return false;
  }
}

// True when the PDF has an /Encrypt entry in its trailer (looked for in the last and first 8 KB, covers normal and linearized files)
function isPdfEncrypted(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(8192, size);
    const tail = Buffer.alloc(len), head = Buffer.alloc(len);
    fs.readSync(fd, tail, 0, len, size - len);
    fs.readSync(fd, head, 0, len, 0);
    fs.closeSync(fd);
    return tail.toString('latin1').includes('/Encrypt') || head.toString('latin1').includes('/Encrypt');
  } catch (e) {
    return false;
  }
}

// Validates file size, magic bytes and archive safety
async function validateUploadSafety(req, res, expectedType) {
  if (!req.file) {
    res.status(400).json({ error: 'NO_FILE', message: 'No file received.' });
    return false;
  }

  // 1. Enforce individual file size limit (10 MB)
  if (req.file.size > security.LIMITS.MAX_FILE_SIZE_BYTES) {
    safeUnlink(req.file.path);
    res.status(413).json({
      error: 'FILE_TOO_LARGE',
      message: 'Maximum file size is 10 MB.'
    });
    return false;
  }

  // 2. Validate magic bytes / file signature
  if (expectedType && !security.verifyFileSignature(req.file.path, expectedType)) {
    safeUnlink(req.file.path);
    res.status(415).json({
      error: 'UNSUPPORTED_MEDIA_TYPE',
      message: `File content does not match expected ${expectedType.toUpperCase()} format.`
    });
    return false;
  }

  // 3. Inspect archive bombs for Office/ZIP documents
  if (expectedType === 'office' || expectedType === 'zip') {
    const archiveCheck = await security.inspectArchiveSafety(req.file.path);
    if (!archiveCheck.safe) {
      safeUnlink(req.file.path);
      res.status(400).json({
        error: 'MALICIOUS_INPUT',
        message: `Security check rejected this archive: ${archiveCheck.reason}`
      });
      return false;
    }
  }

  return true;
}

// Returns true when the upload is present and is really a PDF
function requirePdf(req, res, allowEncrypted) {
  if (!req.file) {
    res.status(400).json({ error: 'NO_FILE', message: 'No file received.' });
    return false;
  }
  if (req.file.size > security.LIMITS.MAX_FILE_SIZE_BYTES) {
    safeUnlink(req.file.path);
    res.status(413).json({
      error: 'FILE_TOO_LARGE',
      message: 'Maximum file size is 10 MB.'
    });
    return false;
  }
  if (!isPdfFile(req.file.path)) {
    safeUnlink(req.file.path);
    res.status(415).json({ error: 'UNSUPPORTED_MEDIA_TYPE', message: 'That file is not a valid PDF.' });
    return false;
  }
  if (!allowEncrypted && isPdfEncrypted(req.file.path)) {
    safeUnlink(req.file.path);
    res.status(422).json({ error: 'PDF_PASSWORD_PROTECTED', message: 'This PDF is password-protected. Unlock it first with the Unlock PDF tool, then try again.' });
    return false;
  }
  return true;
}

async function downloadAndClean(res, filePath, downloadName, alsoDelete) {
  const req = res.req;
  // Last check before anything is offered to the user: the file exists, is not empty, has the format its extension
  // claims and can be opened (PDF page count, Office package structure, image signature, archive entries).
  try {
    jobgate.setProgress({ stage: 'validating' });
    await assertValidOutput(filePath);
    jobgate.setProgress({ stage: 'preparing' });
  } catch (verifyErr) {
    console.error('[output-check] rejected output:', String(verifyErr.message || verifyErr).replace(/[A-Za-z]:\\[^\s]*/g, '<path>'));
    safeUnlink(filePath);
    (alsoDelete || []).forEach(safeUnlink);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'OUTPUT_INVALID', message: 'The converted file could not be verified, so it was not delivered. Please try again, or try a different file.' });
    }
    return;
  }
  const prefersJob = req && (
    req.headers['x-storage-mode'] === 'r2' ||
    req.headers['x-create-job'] === 'true' ||
    (req.headers['accept'] && req.headers['accept'].includes('application/json')) ||
    req.query.job === '1'
  );

  if (prefersJob) {
    try {
      const originalFilename = (req.file && req.file.originalname) || downloadName;
      const job = await r2Storage.saveConvertedJob({
        filePathOrBuffer: filePath,
        originalFilename,
        convertedFilename: downloadName,
        mimeType: r2Storage.getMimeType(downloadName)
      });

      safeUnlink(filePath);
      (alsoDelete || []).forEach(safeUnlink);

      return res.json({
        success: true,
        jobId: job.jobId,
        downloadToken: job.downloadToken,
        downloadUrl: job.downloadUrl,
        apiUrl: job.apiUrl,
        filename: job.filename,
        size: job.size
      });
    } catch (storageErr) {
      if (process.env.REQUIRE_CLOUD_STORAGE === 'true' || r2Storage.isR2Configured) {
        safeUnlink(filePath);
        (alsoDelete || []).forEach(safeUnlink);
        console.error('[Storage] Cloud storage error:', storageErr.message);
        return res.status(502).json({
          error: 'CLOUD_STORAGE_ERROR',
          message: `Failed to store converted file in Cloudflare R2: ${storageErr.message}`
        });
      }
      console.warn('[Storage] Notice during job creation, falling back to direct stream:', storageErr.message);
    }
  }

  res.download(filePath, downloadName, () => {
    safeUnlink(filePath);
    (alsoDelete || []).forEach(safeUnlink);
  });
}

// A primary engine failed and a weaker fallback is about to run: log the real reason (incl. Python stderr)
// and flag the response so clients/tests can tell the result did not come from the primary pipeline.
function fallbackNotice(res, stage, err) {
  const detail = String((err && (err.stderr || err.message)) || err).split(String.fromCharCode(10)).map(l => l.trim()).filter(Boolean).slice(-3).join(' | ').slice(0, 400);
  console.warn(`[fallback] ${stage} failed -> using secondary engine: ${detail}`);
  try { if (!res.headersSent) res.set('X-Converter-Fallback', stage); } catch (e) { /* ignore */ }
}

// qpdf exit code 3 means "finished with warnings" (the output file is fine)
async function runQpdf(args) {
  try {
    await execFileP('qpdf', args, { timeout: 90000 });
  } catch (e) {
    if (e && e.code === 3) return;
    throw e;
  }
}

// LibreOffice can only run one conversion at a time reliably, so requests are queued
let libreChain = Promise.resolve();
function withLibreOffice(task) {
  const run = libreChain.then(task, task);
  libreChain = run.catch(() => {});
  return run;
}

function getLibreOfficeCmd() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\LibreOffice\\program\\soffice.com',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com',
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      'soffice.com',
      'soffice',
      'libreoffice'
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return 'libreoffice';
}

function getPythonCmd() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Python312\\python.exe',
      'python',
      'python3',
      'py'
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return 'python3';
}

// A converter can "succeed" and still leave a file nobody can open. Check the result really is a document of its type
// before it is offered for download; throwing here lets the route fall through to the next engine / a clear error.
async function assertValidOutput(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const size = fs.statSync(filePath).size;
  if (size === 0) throw new Error(`Output ${ext || 'file'} is empty`);
  const IMAGE_SIGS = { '.png': [0x89, 0x50, 0x4e, 0x47], '.jpg': [0xff, 0xd8, 0xff], '.jpeg': [0xff, 0xd8, 0xff], '.webp': null };
  if (ext in IMAGE_SIGS) {
    const fd = fs.openSync(filePath, 'r'); const head = Buffer.alloc(12); fs.readSync(fd, head, 0, 12, 0); fs.closeSync(fd);
    const ok = ext === '.webp' ? (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP')
      : IMAGE_SIGS[ext].every((b, i) => head[i] === b);
    if (!ok) throw new Error(`Output ${ext} is not a valid image`);
    return;
  }
  if (ext === '.zip') {
    const zipCheck = await require('jszip').loadAsync(fs.readFileSync(filePath));
    if (!Object.keys(zipCheck.files).length) throw new Error('Output archive is empty');
    return;
  }
  if (!['.pdf', '.docx', '.pptx', '.xlsx'].includes(ext)) return;
  if (size < 100) throw new Error(`Output ${ext} is empty`);
  if (ext === '.pdf') {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(8); fs.readSync(fd, head, 0, 8, 0);
    const tailLen = Math.min(2048, size); const tail = Buffer.alloc(tailLen); fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    fs.closeSync(fd);
    if (!head.toString('latin1').startsWith('%PDF-') || !tail.toString('latin1').includes('%%EOF')) throw new Error('Output PDF is truncated');
    if (size < 40 * 1024 * 1024) {
      const doc = await PDFDocument.load(fs.readFileSync(filePath), { ignoreEncryption: true, updateMetadata: false });
      if (doc.getPageCount() < 1) throw new Error('Output PDF has no pages');
    }
    return;
  }
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const need = { '.docx': 'word/document.xml', '.pptx': 'ppt/presentation.xml', '.xlsx': 'xl/workbook.xml' }[ext];
  if (!need) return;
  if (!zip.file(need) || !zip.file('[Content_Types].xml')) throw new Error(`Output ${ext} is missing ${need}`);
  if (ext === '.pptx' && !Object.keys(zip.files).some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) throw new Error('Output presentation has no slides');
  if (ext === '.docx') {
    const xml = await zip.file(need).async('string');
    if (!/<w:body>/.test(xml)) throw new Error('Output document has no body');
  }
}

const toolsConverterPath = path.join(__dirname, 'tools_converter.py');
async function runRealTool(toolCmd, inputPath, outputPath, extraArgs = []) {
  const pyCmd = getPythonCmd();
  const args = [toolsConverterPath, toolCmd, inputPath, outputPath, ...extraArgs];
  const proc = await execFileP(pyCmd, args, { timeout: 280000, maxBuffer: 64 * 1024 * 1024 });
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 50) {
    throw new Error(`Real tool ${toolCmd} did not produce valid non-empty output at ${outputPath}`);
  }
  await assertValidOutput(outputPath);
  return { outputPath, stdout: proc.stdout || '', stderr: proc.stderr || '' };
}

// A fallback engine can 'succeed' with an almost empty document; refuse such output so the next engine gets a chance
async function docxHasContent(filePath) {
  try {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    const f = zip.file('word/document.xml');
    if (!f) return false;
    const xml = await f.async('string');
    const text = (xml.match(/<w:t[ >][^<]*/g) || []).join('').length;
    return text >= 40 || /<w:drawing|<w:pict/.test(xml);
  } catch (e) { return false; }
}

// LibreOffice cannot load a .docx whose document.xml points at comments that have no comments part (Word ignores them)
async function sanitizeDocxForLibreOffice(filePath) {
  try {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    if (!zip.file('word/document.xml') || Object.keys(zip.files).some(n => n.startsWith('word/comments'))) return false;
    let xml = await zip.file('word/document.xml').async('string');
    if (!/commentReference|commentRange/.test(xml)) return false;
    xml = xml.replace(/<w:commentRange(?:Start|End)(?=[ /])[^>]*\/>/g, '')
      .replace(/<w:r(?:\s[^>]*)?>(?:<w:rPr>[\s\S]*?<\/w:rPr>|<w:rPr\/>)?<w:commentReference(?=[ /])[^>]*\/><\/w:r>/g, '')
      .replace(/<w:commentReference(?=[ /])[^>]*\/>/g, '');
    zip.file('word/document.xml', xml);
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    return true;
  } catch (e) { return false; }
}

// Converts a file with LibreOffice and returns the path of the result (written to outDir)
async function libreConvert(inputPath, targetExt, extraArgs) {
  if (/\.docx$/i.test(inputPath)) await sanitizeDocxForLibreOffice(inputPath);
  const loCmd = getLibreOfficeCmd();
  const profileUri = 'file:///' + loProfileDir.replace(/\\/g, '/').replace(/^\/+/, '');
  const args = [
    '--headless',
    '--norestore',
    `-env:UserInstallation=${profileUri}`,
    ...(extraArgs || []),
    '--convert-to', targetExt,
    '--outdir', outDir,
    inputPath
  ];
  await withLibreOffice(() => execFileP(loCmd, args, { timeout: 120000 }));
  const out = path.join(outDir, `${path.parse(inputPath).name}.${targetExt.split(':')[0]}`);
  if (!fs.existsSync(out)) throw new Error('The converted file was not produced.');
  await assertValidOutput(out);
  return out;
}

function safeBase(filename) {
  const base = String(filename || 'document')
    .replace(/\.[^/.]+$/, '')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .trim()
    .slice(0, 80);
  return base || 'document';
}

// Health Check
let workingGeminiModel = null;
// What the page shows while a conversion runs (queue position, page N of M, validating ...). Only coarse numbers.
app.get('/api/progress/:id', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const p = jobgate.getProgress(req.params.id);
  if (!p) return res.status(400).json({ error: 'INVALID_ID' });
  res.json(p);
});

app.get('/health', (req, res) => {
  // Used by the website to wake the service and by uptime checks. Does no conversion work, takes no queue slot and
  // initialises nothing; only coarse job counts are reported (no paths, versions, keys or model names).
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok', jobs: jobgate.stats() });
});

// =====================================================================
// GEMINI HELPERS
// Models get retired often, so we try several in order, remember the one
// that works, and as a last resort ask Google which models are available.
// You can force a model by setting GEMINI_MODEL in Render's environment.
// =====================================================================
const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'; // GEMINI_BASE_URL: tests point this at a local mock

const PREFERRED_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-3-flash-preview',
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite-preview'
].filter(Boolean);

async function callGemini(model, promptOrParts, apiKey, opts) {
  const parts = Array.isArray(promptOrParts) ? promptOrParts : [{ text: promptOrParts }];
  const generationConfig = { temperature: 0.2, maxOutputTokens: 8192 };
  if (opts && opts.json) generationConfig.responseMimeType = 'application/json';

  const response = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig
    })
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
}

async function discoverModel(apiKey, alreadyTried) {
  const r = await fetch(`${GEMINI_BASE}/models?pageSize=200`, {
    headers: { 'x-goog-api-key': apiKey }
  });
  const d = await r.json().catch(() => ({}));
  const names = (d.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''))
    .filter((n) => /^gemini-/.test(n))
    .filter((n) => !/(image|tts|audio|live|embedding|robotics|computer-use|vision|learnlm|aqa|imagen|veo)/.test(n))
    .filter((n) => !alreadyTried.includes(n))
    .sort()
    .reverse();
  return names.find((n) => /flash/.test(n) && !/lite/.test(n)) || names.find((n) => /flash/.test(n)) || names[0] || null;
}

async function generateTextOnce(prompt, apiKey, opts) {
  const order = [...new Set([workingGeminiModel, ...PREFERRED_MODELS].filter(Boolean))];
  const tried = [];
  let lastMessage = 'Gemini API request failed.';
  let lastStatus = 0;

  const attempt = async (model) => {
    tried.push(model);
    const result = await callGemini(model, prompt, apiKey, opts);

    if (result.ok) {
      const text = extractText(result.data);
      if (text) {
        workingGeminiModel = model;
        return { text };
      }
      const reason = result.data?.promptFeedback?.blockReason || result.data?.candidates?.[0]?.finishReason || 'empty response';
      lastMessage = `Gemini returned no text (${reason}).`;
      lastStatus = 0;
      return { retry: true };
    }

    lastStatus = result.status;
    lastMessage = result.data?.error?.message || `Gemini error ${result.status}`;
    console.error(`Gemini model ${model} failed (${result.status}):`, lastMessage);

    // Model retired / unavailable / busy / out of quota on this model: try the next one
    if ([404, 429, 500, 503].includes(result.status)) {
      if (model === workingGeminiModel) workingGeminiModel = null;
      return { retry: true };
    }
    // Bad key, blocked key, malformed request: trying other models will not help
    throw new Error(lastMessage);
  };

  for (const model of order) {
    const out = await attempt(model);
    if (out.text) return out.text;
  }

  // Last resort: ask Google which models this key can use
  const discovered = await discoverModel(apiKey, tried);
  if (discovered) {
    const out = await attempt(discovered);
    if (out.text) return out.text;
  }

  const err = new Error(lastMessage);
  if (lastStatus === 429) {
    err.quota = true;
    err.message = 'The free Gemini usage limit was reached. Please wait a minute and try again.';
  }
  throw err;
}

// Retries a few times when Google says "too many requests"
async function generateText(prompt, apiKey, opts) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await generateTextOnce(prompt, apiKey, opts || {});
    } catch (err) {
      lastErr = err;
      if (!err.quota) throw err;
      await sleep(6000 * (i + 1));
    }
  }
  throw lastErr;
}

function parseJsonLoose(raw) {
  const cleaned = String(raw || '').replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const a = cleaned.indexOf('{');
    const b = cleaned.lastIndexOf('}');
    if (a !== -1 && b > a) {
      try {
        return JSON.parse(cleaned.slice(a, b + 1));
      } catch (e2) {
        /* fall through */
      }
    }
  }
  throw new Error('The AI response could not be read (it may have been cut off). Please try again.');
}

function requireGeminiKey(res) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    return null;
  }
  return apiKey;
}

// =====================================================================
// AI EXECUTIVE SUMMARIZER (Powered by Google Gemini & Local Intelligence Engine)
// =====================================================================
function cleanDocumentText(rawText) {
  if (!rawText) return '';
  return String(rawText)
    // Strip isolated artificial page numbers and page markers
    .replace(/^--- (?:Page|Slide)\s+\d+ ---\s*$/gim, '')
    .replace(/^\s*(?:Page|Slide|p\.)\s+\d+\s*(?:of|\/)\s*\d+\s*$/gim, '')
    .replace(/^\s*(?:Page|Slide|p\.)\s+\d+\s*$/gim, '')
    // Normalize spaces and line breaks
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function generateLocalSummary(cleanText, docName, length, pageCount) {
  // Extractive only: every sentence below is copied from the document. Nothing is generated, inferred or "interpreted",
  // so this fallback cannot invent facts (it simply reads less well than the AI summary).
  const sanitized = cleanDocumentText(cleanText).replace(/^[•●▪\-*]\s*$/gm, '');
  const lines = sanitized.split('\n').map((l) => l.trim()).filter(Boolean);
  const words = sanitized.split(/\s+/).filter(Boolean).length;

  // headings: short lines without sentence punctuation (numbered, ALL CAPS or Title Case)
  const isHeading = (l) => l.length >= 4 && l.length <= 70 && !/[.!?:;,]$/.test(l) && !/^\d+$/.test(l) &&
    (/^\d+(\.\d+)*[.)]?\s+\S/.test(l) || l === l.toUpperCase() && /[A-Z]{3}/.test(l) || /^([A-Z][\w&'-]*\s?){1,8}$/.test(l));
  const headings = [];
  for (const l of lines) {
    if (isHeading(l) && !headings.includes(l) && !/^(page|slide)\b/i.test(l)) headings.push(l);
  }

  const text = lines.join(' ').replace(/\s+/g, ' ');
  const sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.replace(/^[•●▪*\-\d.)\s]+/, '').trim())
    .filter((s) => s.length >= 40 && s.length <= 400 && /[a-z]/.test(s) && !/^(?:page|slide)\s+\d+/i.test(s));

  // evidence-based document type (needs several independent hits; otherwise no claim is made)
  const lower = text.toLowerCase();
  const hits = (re) => (lower.match(re) || []).length;
  let docType = '';
  if (hits(/\b(objective|skills|experience|education|projects|certifications|references available)\b/g) >= 4 && (pageCount || 1) <= 3) docType = 'resume / CV';
  else if (hits(/\b(invoice|bill to|billed to|total due|amount due|subtotal|payment terms)\b/g) >= 3) docType = 'invoice / billing document';
  else if (hits(/\b(agreement|party|parties|hereby|clause|governing law|confidential(ity)?)\b/g) >= 5) docType = 'contract / agreement';
  else if (hits(/\b(abstract|methodology|literature review|references|conclusion|introduction)\b/g) >= 4) docType = 'report / paper';

  const target = length === 'brief' ? 4 : length === 'detailed' ? 10 : 6;
  const score = (s) => {
    let sc = 0;
    if (/\d/.test(s)) sc += 3;
    if (/\b(objective|aim|result|conclusion|recommend|require|achiev|improv|increase|decrease|total|significant|propos|design|enables?|ensures?)\w*/i.test(s)) sc += 3;
    if (s.length > 60 && s.length < 220) sc += 2;
    return sc;
  };
  // spread the picks over the whole document: best sentence of each equal-sized segment, kept in reading order
  const picks = [];
  if (sentences.length) {
    const seg = Math.max(1, Math.ceil(sentences.length / target));
    for (let i = 0; i < sentences.length; i += seg) {
      const part = sentences.slice(i, i + seg);
      picks.push(part.reduce((a, b) => (score(b) > score(a) ? b : a)));
    }
  }
  const unique = [...new Set(picks)].slice(0, target);

  const numeric = sentences.filter((s) => /\d/.test(s) && /[%$₹€£]|\b\d{2,}\b/.test(s)).filter((s) => !unique.includes(s)).slice(0, Math.min(6, target));

  // a conclusion only when the document has one: the text that follows a "Conclusion" heading
  let conclusion = '';
  const ci = lines.findIndex((l) => /^(\d+(\.\d+)*[.)]?\s*)?(conclusions?|summary|conclusion and future (scope|work))\b/i.test(l) && l.length < 60);
  if (ci >= 0) conclusion = lines.slice(ci + 1, ci + 8).join(' ').replace(/\s+/g, ' ').slice(0, 600);

  const stats = `${pageCount ? pageCount + ' pages, ' : ''}about ${words.toLocaleString('en-US')} words`;
  let md = `## Executive Summary\n`;
  md += `"${docName}"${docType ? ` appears to be a ${docType}` : ''} (${stats}). `;
  md += (sentences[0] ? sentences[0] : '') + (sentences[1] ? ' ' + sentences[1] : '') + '\n\n';
  md += `_Basic summary: the AI summarizer was not available, so these are key sentences copied from the document, not a rewritten analysis._\n\n`;

  if (headings.length >= 2) {
    md += `## Document Overview\nMain sections found: ${headings.slice(0, 12).map((h) => h.replace(/\*/g, '')).join(' · ')}\n\n`;
  }
  if (unique.length) {
    md += `## Key Points\n` + unique.map((k) => `* ${k}`).join('\n') + '\n\n';
  }
  if (numeric.length) {
    md += `## Figures and Details Mentioned\n` + numeric.map((k) => `* ${k}`).join('\n') + '\n\n';
  }
  if (conclusion) md += `## Conclusion (from the document)\n${conclusion}\n`;
  return md.trim() + '\n';
}

app.post('/api/summarize', async (req, res) => {
  try {
    const { text, filename, length, language, pageCount } = req.body;
    const images = (Array.isArray(req.body.images) ? req.body.images : [])
      .filter((i) => typeof i === 'string' && i.length > 100)
      .slice(0, 12)
      .map((i) => i.replace(/^data:image\/\w+;base64,/, ''));
    const rawText = typeof text === 'string' ? text.trim() : '';
    const cleanText = cleanDocumentText(rawText);

    if (cleanText.length < 30 && !images.length) {
      return res.status(400).json({ error: 'Insufficient document text provided.' });
    }

    const docName = String(filename || 'Document').replace(/["\r\n]+/g, ' ').slice(0, 120);
    const apiKey = process.env.GEMINI_API_KEY;

    // If Gemini API Key is configured, run Google Gemini cloud model
    if (apiKey) {
      try {
        const lengthRule = SUMMARY_LENGTHS[length] || SUMMARY_LENGTHS.standard;
        const langRule = LANGS[language]
          ? `Write the entire summary in ${LANGS[language]}.`
          : 'Write the summary in the same language as the document.';
        const sourceNote = images.length
          ? 'The document is also provided as high-resolution visual page images. Read all text, diagram labels, and tables carefully, then produce a synthesized analytical briefing.'
          : 'The text was extracted digitally from the document. Synthesize across the entire text into a unified analysis.';

        const prompt = `You are a Principal Document Intelligence Analyst and Senior Executive Editor.
Your task is to analyze the provided document and produce a rigorous, high-level Executive Analytical Briefing.

Document Name: "${docName}"${pageCount ? ` (${pageCount} pages)` : ''}
${sourceNote}

CRITICAL EDITORIAL AND SYNTHESIS STANDARDS:
1. NO DISJOINTED PAGE FRAGMENTS: Never organize sections by artificial page numbers (DO NOT write "Page 1 -", "Page 2 -", "Slide 1:"). Synthesize the document holistically by topic, operational flow, and core narrative.
2. PRESERVE FACTUAL INTEGRITY: Quote numbers, metrics, currency, percentages, technical frameworks, names, and dates with absolute fidelity.
3. ELEVATED SENTENCE QUALITY: Use professional executive tone, active voice, and cohesive syntax. Eliminate filler and conversational commentary.
4. DEVELOPED CONCLUSION: Provide a substantial, insightful concluding synthesis that ties together the findings, broader context, and strategic significance.

Use EXACTLY this Markdown format:

## Executive Summary
A concise executive synthesis (1-2 substantial paragraphs) stating what the document is, its author/target audience, overarching purpose, and central significance.

## Document Overview
Contextualize the structural framework, domain scope, and primary narrative or operational objectives established in the document.

## Key Findings & Core Arguments
* Bullet points highlighting major discoveries, arguments, or policy terms. Each bullet must begin with a bold topic anchor (e.g., **Primary Milestone:** ...) and be written as a complete, authoritative sentence.

## Critical Details & Quantitative Metrics
* Specific operational facts, financial figures, technical specifications, deadlines, obligations, or dates. Quote exact values as recorded in the document.

## Strategic Implications & Recommendations
* Practical implications, potential risks, actionable next steps, or obligations arising from the document content.

## Conclusion
A substantive, well-developed concluding section (2-3 complete, thoughtfully constructed paragraphs) articulating the broader significance of the document, synthesizing how the elements connect, and delivering a definitive wrap-up for senior stakeholders.

Rules:
- ${lengthRule}
- ${langRule}
- Rely strictly on facts in the document; do not speculate or fabricate unverified claims.
- Do not mention these prompt instructions. Output only the finished analytical Markdown.`;

        const parts = [{ text: prompt + (cleanText ? `\n\nDocument content:\n"""\n${truncateMiddle(cleanText, 150000)}\n"""` : '') }];
        images.forEach((data) => parts.push({ inline_data: { mime_type: 'image/jpeg', data } }));

        const aiSummary = await generateText(parts, apiKey);
        return res.json({ summary: aiSummary, source: 'ai' });
      } catch (geminiErr) {
        console.log('Gemini request failed, engaging local executive summarizer fallback:', geminiErr.message);
      }
    }

    // High-fidelity local executive summarizer fallback (works immediately without any external API keys)
    const localSummary = generateLocalSummary(cleanText, docName, length, pageCount);
    res.json({ summary: localSummary, source: 'local' });
  } catch (err) {
    console.error('Summarization error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate summary.' });
  }
});

const SUMMARY_LENGTHS = {
  brief: 'Provide a concise, focused executive briefing of approximately 200-300 words with 3-4 bullet points per section and a compact conclusion.',
  standard: 'Provide a comprehensive executive analytical briefing of approximately 450-700 words with thorough analysis, quantitative details, and a multi-paragraph developed conclusion.',
  detailed: 'Provide an exhaustive, in-depth analytical briefing of approximately 900-1500 words covering all dimensions, strategic implications, empirical data, and an extensive strategic conclusion.'
};

function truncateMiddle(text, max) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return text.slice(0, head) + '\n\n[... the middle of this very long document is omitted ...]\n\n' + text.slice(-tail);
}

function isMostlyRtl(s) {
  const letters = String(s).match(/\p{L}/gu) || [];
  const rtl = String(s).match(/[\u0590-\u08FF]/g) || [];
  return letters.length > 0 && rtl.length / letters.length > 0.3;
}

// Very small Markdown -> HTML converter for the summary (headings, bullets, **bold**)
function summaryToHtml(md, dirAttr) {
  const inline = (t) => escapeHtml(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  let html = '';
  let inList = false;
  const closeList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };
  for (const raw of String(md).replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    let m;
    if ((m = line.match(/^#{1,3}\s+(.*)$/))) {
      closeList();
      html += `<h2${dirAttr}>${inline(m[1])}</h2>`;
    } else if ((m = line.match(/^[*\-\u2022]\s+(.*)$/))) {
      if (!inList) {
        html += `<ul${dirAttr}>`;
        inList = true;
      }
      html += `<li>${inline(m[1])}</li>`;
    } else {
      closeList();
      html += `<p${dirAttr}>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

async function buildNativeSummaryPdf(summary, name, pageCount) {
  const doc = await PDFDocument.create();
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);

  let page = doc.addPage([612, 792]);
  let cursorY = 740;

  // Header Banner
  page.drawRectangle({
    x: 40,
    y: 700,
    width: 532,
    height: 52,
    color: rgb(0.06, 0.2, 0.45)
  });
  page.drawText('Fileora AI Summary', {
    x: 55,
    y: 728,
    size: 17,
    font: fontBold,
    color: rgb(1, 1, 1)
  });
  page.drawText(`Document: ${String(name || 'Document').slice(0, 50)} | ${pageCount ? `${pageCount} pages | ` : ''}Verified Intelligence`, {
    x: 55,
    y: 712,
    size: 9,
    font: fontRegular,
    color: rgb(0.8, 0.88, 0.95)
  });

  cursorY = 675;

  const lines = String(summary || '').replace(/\r/g, '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      cursorY -= 8;
      continue;
    }

    if (cursorY < 60) {
      page = doc.addPage([612, 792]);
      cursorY = 740;
    }

    if (/^#{1,3}\s+/.test(line)) {
      const heading = line.replace(/^#{1,3}\s+/, '').replace(/\*\*/g, '').trim();
      cursorY -= 8;
      page.drawText(heading, {
        x: 45,
        y: cursorY,
        size: 13,
        font: fontBold,
        color: rgb(0.01, 0.41, 0.63)
      });
      cursorY -= 18;
    } else if (/^[*\-\u2022]\s+/.test(line)) {
      let rawBullet = line.replace(/^[*\-\u2022]\s+/, '').trim();
      page.drawText('\u2022', {
        x: 55,
        y: cursorY,
        size: 10,
        font: fontBold,
        color: rgb(0.12, 0.23, 0.54)
      });

      // Check if bullet begins with a bold anchor: **Anchor:** Body
      let anchor = '';
      let body = rawBullet;
      const anchorMatch = rawBullet.match(/^\*\*(.+?)\*\*[:\s]*(.*)$/);
      if (anchorMatch) {
        anchor = anchorMatch[1].replace(/\*/g, '').trim() + ': ';
        body = anchorMatch[2].replace(/\*\*/g, '').trim();
      } else {
        body = rawBullet.replace(/\*\*/g, '').trim();
      }

      const bulletText = (anchor ? anchor + body : body).trim();
      const words = bulletText.split(' ');
      let currentLine = '';
      let isFirstLine = true;

      for (const w of words) {
        if ((currentLine + ' ' + w).length > 78) {
          page.drawText(currentLine, {
            x: 70,
            y: cursorY,
            size: 9.5,
            font: isFirstLine && anchor ? fontBold : fontRegular,
            color: rgb(0.12, 0.16, 0.23)
          });
          isFirstLine = false;
          cursorY -= 14;
          if (cursorY < 60) {
            page = doc.addPage([612, 792]);
            cursorY = 740;
          }
          currentLine = w;
        } else {
          currentLine = currentLine ? currentLine + ' ' + w : w;
        }
      }
      if (currentLine) {
        page.drawText(currentLine, {
          x: 70,
          y: cursorY,
          size: 9.5,
          font: isFirstLine && anchor ? fontBold : fontRegular,
          color: rgb(0.12, 0.16, 0.23)
        });
        cursorY -= 15;
      }
    } else {
      const cleanLine = line.replace(/\*\*/g, '').trim();
      const words = cleanLine.split(' ');
      let currentLine = '';
      for (const w of words) {
        if ((currentLine + ' ' + w).length > 85) {
          page.drawText(currentLine, { x: 45, y: cursorY, size: 9.5, font: fontRegular, color: rgb(0.2, 0.25, 0.33) });
          cursorY -= 14;
          if (cursorY < 60) {
            page = doc.addPage([612, 792]);
            cursorY = 740;
          }
          currentLine = w;
        } else {
          currentLine = currentLine ? currentLine + ' ' + w : w;
        }
      }
      if (currentLine) {
        page.drawText(currentLine, { x: 45, y: cursorY, size: 9.5, font: fontRegular, color: rgb(0.2, 0.25, 0.33) });
        cursorY -= 15;
      }
    }
  }

  const total = doc.getPageCount();
  for (let i = 0; i < total; i++) {
    const p = doc.getPage(i);
    p.drawText(`Page ${i + 1} of ${total}  |  Fileora AI Summary  |  Private & Secure`, {
      x: 45,
      y: 35,
      size: 8,
      font: fontRegular,
      color: rgb(0.58, 0.64, 0.72)
    });
  }

  return await doc.save();
}

// Builds the summary PDF with LibreOffice + Noto fonts (with native engine fallback)
app.post('/api/summary/pdf', security.concurrencyLimiter, async (req, res) => {
  const { summary, filename, pageCount } = req.body;
  if (!summary || String(summary).trim().length < 10) {
    return res.status(400).json({ error: 'No summary to build the PDF from.' });
  }

  const dirAttr = isMostlyRtl(summary) ? ' dir="rtl"' : '';
  const name = safeBase(filename);
  const htmlPath = newOutPath('summary', 'html');
  let pdfPath;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: 'Noto Sans', 'Noto Sans CJK SC', 'Liberation Sans', sans-serif; font-size: 10.5pt; line-height: 1.55; color: #1e293b; }
  h1 { font-size: 18pt; margin: 0 0 4pt 0; color: #0c4a6e; }
  h2 { font-size: 12.5pt; margin: 14pt 0 4pt 0; color: #0369a1; }
  p { margin: 0 0 6pt 0; }
  li { margin: 0 0 4pt 0; }
  .meta { font-size: 9pt; color: #64748b; margin: 0 0 10pt 0; }
  .foot { font-size: 8.5pt; color: #94a3b8; margin-top: 16pt; }
</style></head>
<body>
<h1>Fileora AI Summary</h1>
<p class="meta">Document: ${escapeHtml(name)}${pageCount ? ` | ${Number(pageCount) || ''} pages` : ''} | Created ${new Date().toISOString().slice(0, 10)}</p>
${summaryToHtml(summary, dirAttr)}
<p class="foot">Created automatically with Google Gemini. Please check important details against the original document.</p>
</body></html>`;

  try {
    fs.writeFileSync(htmlPath, html, 'utf8');
    pdfPath = await libreConvert(htmlPath, 'pdf', ['--infilter=HTML (StarWriter)']);
    downloadAndClean(res, pdfPath, `Summary_${name}.pdf`, [htmlPath]);
  } catch (err) {
    safeUnlink(htmlPath);
    safeUnlink(pdfPath);
    console.log('LibreOffice unavailable/failed for summary PDF. Engaging native Fileora PDF engine...');
    try {
      const pdfBytes = await buildNativeSummaryPdf(summary, name, pageCount);
      const out = newOutPath('summary', 'pdf');
      fs.writeFileSync(out, pdfBytes);
      downloadAndClean(res, out, `Summary_${name}.pdf`);
    } catch (fallbackErr) {
      console.error('Native summary PDF generation failed:', fallbackErr);
      res.status(500).json({ error: 'Could not build the summary PDF.' });
    }
  }
});

// =====================================================================
// TRANSLATE (Gemini): the browser sends the text in chunks, then asks for a PDF
// =====================================================================
const LANGS = {
  en: 'English', hi: 'Hindi', te: 'Telugu', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam',
  bn: 'Bengali', mr: 'Marathi', gu: 'Gujarati', pa: 'Punjabi', ur: 'Urdu', es: 'Spanish',
  fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', ru: 'Russian', ar: 'Arabic',
  zh: 'Chinese (Simplified)', ja: 'Japanese', ko: 'Korean'
};
const RTL_LANGS = ['ar', 'ur'];

app.post('/api/translate', async (req, res) => {
  try {
    const { text, targetLang } = req.body;
    const langName = LANGS[targetLang];
    if (!langName) return res.status(400).json({ error: 'Unsupported target language.' });
    if (!text || text.trim().length < 2) return res.status(400).json({ error: 'No text to translate.' });

    const apiKey = requireGeminiKey(res);
    if (!apiKey) return;

    const prompt = `Translate the text below into ${langName}.
Keep the same paragraph breaks (blank lines) and line breaks.
Keep names, numbers, dates, URLs and email addresses unchanged.
Output ONLY the translated text, with no explanations, notes or quotation marks around it.

Text:
"""
${text.slice(0, 12000)}
"""`;

    const translated = await generateText(prompt, apiKey);
    res.json({ translated });
  } catch (err) {
    console.error('Translate error:', err);
    res.status(500).json({ error: err.message || 'Translation failed.' });
  }
});

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Builds a PDF from translated text using LibreOffice + Noto fonts (supports Hindi, Telugu, Arabic, CJK...)
app.post('/api/translate/pdf', security.concurrencyLimiter, async (req, res) => {
  const { text, targetLang, filename } = req.body;
  if (!LANGS[targetLang]) return res.status(400).json({ error: 'Unsupported target language.' });
  if (!text || text.trim().length < 2) return res.status(400).json({ error: 'No text to build the PDF from.' });

  const htmlPath = newOutPath('translated', 'html');
  let pdfPath;
  const dirAttr = RTL_LANGS.includes(targetLang) ? ' dir="rtl"' : '';

  const paragraphs = String(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p${dirAttr}>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: 'Noto Sans', 'Noto Sans CJK SC', 'Liberation Sans', sans-serif; font-size: 11pt; line-height: 1.5; }
  p { margin: 0 0 8pt 0; }
</style></head>
<body>
${paragraphs}
</body></html>`;

  try {
    fs.writeFileSync(htmlPath, html, 'utf8');
    pdfPath = await libreConvert(htmlPath, 'pdf', ['--infilter=HTML (StarWriter)']);
    downloadAndClean(res, pdfPath, `${safeBase(filename)}_${targetLang}.pdf`, [htmlPath]);
  } catch (err) {
    safeUnlink(htmlPath);
    safeUnlink(pdfPath);
    console.error('Translate PDF error:', err.stderr || err);
    res.status(500).json({ error: 'Could not build the translated PDF.' });
  }
});

// =====================================================================
// PDF TO EXCEL (Gemini finds the tables, ExcelJS builds the workbook)
// =====================================================================
app.post('/api/ai/tables', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.trim().length < 20) {
      return res.status(400).json({ error: 'Not enough text to look for tables.' });
    }
    const apiKey = requireGeminiKey(res);
    if (!apiKey) return;

    const prompt = `You extract tables from text taken from a PDF. Columns are separated by TAB characters or runs of spaces, and each table row is on its own line.
Find every real table (rows and columns of data, including item lists with several columns). Ignore normal paragraphs.
Return ONLY valid JSON in exactly this shape: {"tables":[{"name":"short title","rows":[["cell","cell"],["cell","cell"]]}]}
Rules: copy every row and cell exactly as in the text (never summarize or invent data); the first row is the header row when the table has one; every row must have the same number of cells (use "" for empty cells); if there are no tables return {"tables":[]}.

Text:
"""
${text.slice(0, 16000)}
"""`;

    const raw = await generateText(prompt, apiKey, { json: true });
    const parsed = parseJsonLoose(raw);
    const tables = (Array.isArray(parsed && parsed.tables) ? parsed.tables : []).filter(
      (t) => t && Array.isArray(t.rows) && t.rows.length
    );
    res.json({ tables });
  } catch (err) {
    console.error('Table extraction error:', err);
    res.status(500).json({ error: err.message || 'Table extraction failed.' });
  }
});

function toCell(v) {
  const s = String(v === null || v === undefined ? '' : v);
  const t = s.trim();
  if (/^-?\d+(\.\d+)?$/.test(t) && !/^-?0\d/.test(t) && t.length < 16) return Number(t);
  return s;
}

app.post('/api/convert/tables-to-xlsx', security.concurrencyLimiter, async (req, res) => {
  try {
    const tables = req.body && req.body.tables;
    if (!Array.isArray(tables) || tables.length === 0) {
      return res.status(400).json({ error: 'No tables to export.' });
    }

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const used = new Set();

    tables.slice(0, 50).forEach((t, i) => {
      const rows = Array.isArray(t.rows) ? t.rows.filter(Array.isArray) : [];
      if (!rows.length) return;

      let name = String(t.name || `Table ${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || `Table ${i + 1}`;
      let unique = name;
      let n = 2;
      while (used.has(unique.toLowerCase())) unique = `${name.slice(0, 25)} ${n++}`;
      used.add(unique.toLowerCase());

      const ws = wb.addWorksheet(unique);
      rows.forEach((r) => ws.addRow(r.map(toCell)));
      ws.getRow(1).font = { bold: true };

      const colCount = Math.max(...rows.map((r) => r.length));
      for (let c = 1; c <= colCount; c++) {
        let max = 10;
        rows.forEach((r) => {
          max = Math.max(max, String(r[c - 1] === undefined || r[c - 1] === null ? '' : r[c - 1]).length + 2);
        });
        ws.getColumn(c).width = Math.min(max, 60);
      }
    });

    if (wb.worksheets.length === 0) return res.status(400).json({ error: 'No tables to export.' });

    const buf = await wb.xlsx.writeBuffer();
    const tempXlsx = newOutPath('tables', 'xlsx');
    fs.writeFileSync(tempXlsx, Buffer.from(buf));
    return downloadAndClean(res, tempXlsx, 'Extracted_Tables.xlsx');
  } catch (err) {
    console.error('XLSX build error:', err);
    res.status(500).json({ error: 'Could not build the Excel file.' });
  }
});

// PDF TO EXCEL (.pdf to .xlsx via PyMuPDF table & OCR extractor + native engine fallback)
app.post('/api/convert/to-xlsx', security.concurrencyLimiter, gatedUpload.single('file'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  const originalName = req.file.originalname;
  let output = newOutPath('tables', 'xlsx');

  try {
    // Primary: Deterministic Table & OCR Spreadsheet Extractor
    await runRealTool('pdf2xlsx', input, output);
    downloadAndClean(res, output, `${path.parse(originalName).name}.xlsx`, [input]);
  } catch (err) {
    fallbackNotice(res, 'Real pdf2xlsx tool', err);
    try {
      const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
      const data = new Uint8Array(fs.readFileSync(input));
      const doc = await pdfjsLib.getDocument({ data }).promise;
      const xlsxBuf = await converterEngine.convertPdfToXlsx(doc);
      fs.writeFileSync(output, xlsxBuf);
      downloadAndClean(res, output, `${path.parse(originalName).name}.xlsx`, [input]);
    } catch (fallbackErr) {
      safeUnlink(input);
      safeUnlink(output);
      console.error('All PDF to Excel engines failed:', fallbackErr);
      res.status(500).json({ error: 'Could not convert this PDF to Excel spreadsheet.' });
    }
  }
});

// =====================================================================
// 1. HIGH-FIDELITY OFFICE CONVERTER (DOCX, PPTX, XLSX to PDF)
// =====================================================================
app.post('/api/convert/to-pdf', security.concurrencyLimiter, gatedUpload.single('file', 'office'), async (req, res) => {
  if (!await validateUploadSafety(req, res, 'office')) return;

  const input = req.file.path;
  const originalName = req.file.originalname;
  const ext = path.extname(originalName).toLowerCase();
  let out;
  try {
    // For spreadsheets (XLSX, XLS, CSV), use our high-fidelity optimizer (auto landscape, proportional widths, word wrap, borders, repeated headers)
    if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
      out = newOutPath('converted', 'pdf');
      await runRealTool('xlsx2pdf', input, out);
      return downloadAndClean(res, out, `${path.parse(originalName).name}.pdf`, [input]);
    }

    // Primary for DOCX/PPTX: LibreOffice headless (preserves exact PPTX/DOCX aspect ratio, layout, and images)
    out = await libreConvert(input, 'pdf');
    return downloadAndClean(res, out, `${path.parse(originalName).name}.pdf`, [input]);
  } catch (err) {
    fallbackNotice(res, 'Primary conversion', err);
    try {
      out = newOutPath('converted', 'pdf');
      if (ext === '.pptx') {
        await runRealTool('pptx2pdf', input, out);
      } else if (ext === '.docx') {
        await runRealTool('docx2pdf', input, out);
      } else if (ext === '.xlsx' || ext === '.csv' || ext === '.xls') {
        out = await libreConvert(input, 'pdf');
      } else {
        throw new Error(`Unsupported format: ${ext}`);
      }
      return downloadAndClean(res, out, `${path.parse(originalName).name}.pdf`, [input]);
    } catch (realToolErr) {
      fallbackNotice(res, 'Real tool runner', realToolErr);
      try {
        const fileBytes = fs.readFileSync(input);
        let pdfBytes;
        if (ext === '.docx') {
          pdfBytes = await converterEngine.convertDocxToPdf(fileBytes);
        } else if (ext === '.xlsx' || ext === '.csv' || ext === '.xls') {
          pdfBytes = await converterEngine.convertXlsxToPdf(fileBytes);
        } else if (ext === '.pptx') {
          pdfBytes = await converterEngine.convertPptxToPdf(fileBytes);
        } else {
          throw new Error(`Unsupported format for native conversion: ${ext}`);
        }
        out = newOutPath('converted', 'pdf');
        fs.writeFileSync(out, pdfBytes);
        downloadAndClean(res, out, `${path.parse(originalName).name}.pdf`, [input]);
      } catch (fallbackErr) {
        safeUnlink(input);
        safeUnlink(out);
        console.error('All document compilation engines failed:', fallbackErr);
        res.status(500).json({ error: 'Document compilation failed. Check that the file is a valid, unprotected document.' });
      }
    }
  }
});

// 2. HIGH-FIDELITY PDF TO WORD (PDF to DOCX via pdf2docx real tool, LibreOffice secondary, Native fallback)
app.post('/api/convert/to-docx', security.concurrencyLimiter, gatedUpload.single('file', 'pdf'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  const originalName = req.file.originalname;
  let out;
  try {
    // Primary: Real pdf2docx tool (extracts full text, tables, styles, images, layout 1:1)
    out = newOutPath('converted', 'docx');
    await runRealTool('pdf2docx', input, out);
    downloadAndClean(res, out, `${path.parse(originalName).name}.docx`, [input]);
  } catch (err) {
    fallbackNotice(res, 'pdf2docx tool', err);
    try {
      out = await libreConvert(input, 'docx');
      if (!await docxHasContent(out)) throw new Error('LibreOffice produced an empty document');
      downloadAndClean(res, out, `${path.parse(originalName).name}.docx`, [input]);
    } catch (loErr) {
      fallbackNotice(res, 'LibreOffice PDF-to-DOCX', loErr);
      try {
        const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
        const data = new Uint8Array(fs.readFileSync(input));
        const doc = await pdfjsLib.getDocument({ data }).promise;
        const docxBuf = await converterEngine.convertPdfToDocx(doc);
        out = newOutPath('converted', 'docx');
        fs.writeFileSync(out, docxBuf);
        downloadAndClean(res, out, `${path.parse(originalName).name}.docx`, [input]);
      } catch (fallbackErr) {
        safeUnlink(input);
        safeUnlink(out);
        console.error('All PDF-to-DOCX engines failed:', fallbackErr);
        res.status(500).json({ error: 'Conversion to Word failed. If the PDF is password-protected, unlock it first.' });
      }
    }
  }
});

// 3. PDF TO POWERPOINT (Exact Aspect Ratio via PyMuPDF + python-pptx real tool)
app.post('/api/convert/to-pptx', security.concurrencyLimiter, gatedUpload.single('file', 'pdf'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  const originalName = req.file.originalname;
  let output = newOutPath('slides', 'pptx');

  try {
    // Primary: Native Editable PDF to PPTX (reconstructs text boxes, tables, and separate images)
    await runRealTool('pdf2pptx', input, output);
    downloadAndClean(res, output, `${path.parse(originalName).name}.pptx`, [input]);
  } catch (err) {
    fallbackNotice(res, 'Real pdf2pptx tool', err);
    try {
      const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
        const data = new Uint8Array(fs.readFileSync(input));
        const doc = await pdfjsLib.getDocument({ data }).promise;
        const pagesData = await converterEngine.extractPdfPagesData(doc);

        const pptxgen = require('pptxgenjs');
        const pres = new pptxgen();
        pres.defineLayout({ name: 'PDFSLIDE', width: 10, height: 7.5 });
        pres.layout = 'PDFSLIDE';

        for (const pg of pagesData) {
          let slide = pres.addSlide();
          const layout = converterEngine.analyzePageLayout(pg);
          let curY = 0.8;
          for (const el of layout.elements) {
            if (!el.text) continue;
            if (curY > 6.8) {
              slide = pres.addSlide();
              curY = 0.8;
            }
            const isTitle = el.type === 'heading1' || el.type === 'heading2';
            slide.addText(el.text, {
              x: 0.8,
              y: curY,
              w: 8.4,
              fontSize: isTitle ? 18 : 12,
              bold: isTitle,
              color: isTitle ? '0F172A' : '334155'
            });
            curY += isTitle ? 0.6 : 0.4;
          }
        }
        await pres.writeFile({ fileName: output });
        downloadAndClean(res, output, `${path.parse(originalName).name}.pptx`, [input]);
      } catch (fallbackErr) {
        safeUnlink(input);
        safeUnlink(output);
        console.error('All PDF to PPTX engines failed:', fallbackErr);
        res.status(500).json({ error: 'Could not convert this PDF to PowerPoint. If it is password-protected, unlock it first.' });
      }
    }
});

// WORD TO POWERPOINT (.docx to .pptx)
app.post('/api/convert/word-to-pptx', security.concurrencyLimiter, gatedUpload.single('file', 'docx'), async (req, res) => {
  if (!await validateUploadSafety(req, res, 'office')) return;
  const input = req.file.path;
  const originalName = req.file.originalname;
  let out = newOutPath('converted', 'pptx');
  try {
    // Primary: Real docx2pptx pipeline (LibreOffice DOCX->PDF with exact layout + PyMuPDF exact aspect ratio PPTX)
    await runRealTool('docx2pptx', input, out);
    downloadAndClean(res, out, `${path.parse(originalName).name}.pptx`, [input]);
  } catch (err) {
    fallbackNotice(res, 'Real docx2pptx tool', err);
    try {
      const fileBytes = fs.readFileSync(input);
      const pptxBuf = await converterEngine.convertDocxToPptx(fileBytes);
      fs.writeFileSync(out, pptxBuf);
      downloadAndClean(res, out, `${path.parse(originalName).name}.pptx`, [input]);
    } catch (fallbackErr) {
      safeUnlink(input);
      safeUnlink(out);
      console.error('All DOCX-to-PPTX conversion engines failed:', fallbackErr);
      res.status(500).json({ error: 'Word to PowerPoint conversion failed. Please ensure the document is a valid .docx file.' });
    }
  }
});

// POWERPOINT TO WORD (.pptx to .docx)
async function handlePptxToDocx(req, res) {
  if (!await validateUploadSafety(req, res, 'office')) return;
  const input = req.file.path;
  const originalName = req.file.originalname;
  const mode = (req.body && req.body.mode) ? String(req.body.mode).trim().toLowerCase() : 'editable';
  let out = newOutPath('converted', 'docx');
  try {
    // Primary: High-fidelity Dual-Mode Converter (layout vs editable)
    await runRealTool('pptx2docx', input, out, [mode]);
    downloadAndClean(res, out, `${path.parse(originalName).name}.docx`, [input]);
  } catch (err) {
    fallbackNotice(res, 'Real pptx2docx tool', err);
    try {
      const fileBytes = fs.readFileSync(input);
      const docxBuf = await converterEngine.convertPptxToDocx(fileBytes, { mode });
      fs.writeFileSync(out, docxBuf);
      downloadAndClean(res, out, `${path.parse(originalName).name}.docx`, [input]);
    } catch (fallbackErr) {
      safeUnlink(input);
      safeUnlink(out);
      console.error('PowerPoint to Word fallback error:', fallbackErr);
      res.status(500).json({ error: 'PowerPoint to Word conversion failed. Please ensure the document is a valid .pptx file.' });
    }
  }
}
app.post('/api/convert/pptx-to-docx', security.concurrencyLimiter, gatedUpload.single('file', 'pptx'), handlePptxToDocx);
app.post('/api/convert/powerpoint-to-word', security.concurrencyLimiter, gatedUpload.single('file', 'pptx'), handlePptxToDocx);

// 4. MERGE PDFS (pdf-lib) - kept as a server fallback; the page now merges in the browser
app.post('/api/pdf/merge', security.concurrencyLimiter, gatedUpload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded.' });

  try {
    const mergedDoc = await PDFDocument.create();

    for (const file of req.files) {
      const fileBytes = fs.readFileSync(file.path);
      const doc = await PDFDocument.load(fileBytes);
      const copiedPages = await mergedDoc.copyPages(doc, doc.getPageIndices());
      copiedPages.forEach((p) => mergedDoc.addPage(p));
      safeUnlink(file.path);
    }

    const mergedBytes = await mergedDoc.save();
    const outputPath = path.join(outDir, `Merged-${Date.now()}.pdf`);
    fs.writeFileSync(outputPath, mergedBytes);

    return downloadAndClean(res, outputPath, 'Fileora_Merged.pdf');
  } catch (err) {
    req.files.forEach((f) => safeUnlink(f.path));
    console.error(err);
    res.status(500).json({ error: 'Failed to merge documents.' });
  }
});

// 5. WATERMARK PDF (pdf-lib): centered diagonal text, sized to fit every page
app.post('/api/pdf/watermark', security.concurrencyLimiter, gatedUpload.single('file'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  const output = newOutPath('watermarked', 'pdf');
  const text = String(req.body.text || 'CONFIDENTIAL').trim().slice(0, 60) || 'CONFIDENTIAL';

  try {
    const doc = await PDFDocument.load(fs.readFileSync(input));
    const font = await doc.embedFont(StandardFonts.HelveticaBold);

    try {
      font.widthOfTextAtSize(text, 12);
    } catch (e) {
      safeUnlink(input);
      return res.status(400).json({ error: 'The watermark can only use English letters, numbers and common symbols.' });
    }

    const angle = Math.PI / 4;
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      const maxW = Math.sqrt(width * width + height * height) * 0.7;
      let size = 80;
      let tw = font.widthOfTextAtSize(text, size);
      if (tw > maxW) {
        size = (size * maxW) / tw;
        tw = maxW;
      }
      const th = font.heightAtSize(size);
      page.drawText(text, {
        x: width / 2 - (tw / 2) * Math.cos(angle) + th * 0.35 * Math.sin(angle),
        y: height / 2 - (tw / 2) * Math.sin(angle) - th * 0.35 * Math.cos(angle),
        size,
        font,
        color: rgb(0.8, 0.2, 0.2),
        opacity: 0.25,
        rotate: degrees(45)
      });
    }

    fs.writeFileSync(output, await doc.save());
    downloadAndClean(res, output, `${path.parse(req.file.originalname).name}_watermarked.pdf`, [input]);
  } catch (err) {
    safeUnlink(input);
    safeUnlink(output);
    console.error('Watermark error:', err);
    res.status(500).json({ error: 'Could not add the watermark. If the PDF is password-protected, unlock it first.' });
  }
});

// 6. COMPRESS / OPTIMIZE PDF (Ghostscript for images, qpdf for the file structure)
const COMPRESS_PRESETS = {
  low: { dpi: 200, q: 0.2 },
  recommended: { dpi: 150, q: 0.4 },
  strong: { dpi: 110, q: 0.6 },
  extreme: { dpi: 72, q: 0.9 }
};
const QUALITY_MAP = { high: 0.2, medium: 0.4, low: 0.7, verylow: 0.9 }; // Ghostscript QFactor: lower = better quality
const COMPRESS_LADDER = [
  { dpi: 150, q: 0.4 },
  { dpi: 120, q: 0.55 },
  { dpi: 96, q: 0.7 },
  { dpi: 72, q: 0.85 },
  { dpi: 60, q: 0.92 }
];

function gsCompressArgs(input, output, s, gray) {
  const dict = (q) => `<< /QFactor ${q} /Blend 1 /ColorTransform 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >>`;
  const args = [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.5',
    '-dPDFSETTINGS=/default',
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    '-dDetectDuplicateImages=true',
    '-dCompressFonts=true',
    '-dSubsetFonts=true',
    '-dEmbedAllFonts=true',
    '-dCompressPages=true',
    '-dDownsampleColorImages=true',
    '-dColorImageDownsampleType=/Bicubic',
    `-dColorImageResolution=${s.dpi}`,
    '-dDownsampleGrayImages=true',
    '-dGrayImageDownsampleType=/Bicubic',
    `-dGrayImageResolution=${s.dpi}`,
    '-dDownsampleMonoImages=true',
    '-dMonoImageDownsampleType=/Subsample',
    `-dMonoImageResolution=${Math.max(s.dpi, 150)}`,
    '-dAutoFilterColorImages=false',
    '-dColorImageFilter=/DCTEncode',
    '-dAutoFilterGrayImages=false',
    '-dGrayImageFilter=/DCTEncode'
  ];
  if (gray) args.push('-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray');
  args.push(
    `-sOutputFile=${output}`,
    '-c',
    `<< /ColorACSImageDict ${dict(s.q)} /GrayACSImageDict ${dict(s.q)} >> setdistillerparams`,
    '-f',
    input
  );
  return args;
}

// Rewrites the PDF structure (object streams, recompressed streams); returns { path, size } or null
async function qpdfOptimize(src, tmpList) {
  const out = newOutPath('optimized', 'pdf');
  tmpList.push(out);
  try {
    await runQpdf(['--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9', src, out]);
    return fs.existsSync(out) ? { path: out, size: fs.statSync(out).size } : null;
  } catch (e) {
    return null;
  }
}

// IMAGE COMPRESSOR (Format-aware Pillow engine with Manual Target Size support)
app.post('/api/image/compress', security.concurrencyLimiter, gatedUpload.single('file'), async (req, res) => {
  if (!await validateUploadSafety(req, res, 'image')) return;

  const input = req.file.path;
  const originalName = req.file.originalname;
  const format = String(req.body.format || 'default').trim().toLowerCase();
  const quality = String(req.body.quality || '80').trim();
  const maxDim = String(req.body.maxDim || '0').trim();
  const mode = String(req.body.mode || 'auto').trim().toLowerCase();
  const targetKb = Math.round(Number(req.body.targetKb || 0));

  if (mode === 'manual' && targetKb <= 0) {
    safeUnlink(input);
    return res.status(400).json({ error: 'Please enter a valid target size in KB (greater than 0).' });
  }

  let targetExt = path.extname(originalName).slice(1).toLowerCase();
  if (format === 'jpeg' || format === 'jpg') targetExt = 'jpg';
  else if (format === 'png') targetExt = 'png';
  else if (format === 'webp') targetExt = 'webp';
  if (!targetExt) targetExt = 'jpg';

  const out = newOutPath('compressed_img', targetExt);
  try {
    const inSize = fs.statSync(input).size;
    const { stdout } = await runRealTool('compress_image', input, out, [
      format,
      quality,
      maxDim,
      mode === 'manual' && targetKb > 0 ? String(targetKb) : '0'
    ]);
    const outSize = fs.statSync(out).size;

    let metrics = {};
    const mMatch = stdout.match(/METRICS:(.+)/);
    if (mMatch) {
      try { metrics = JSON.parse(mMatch[1]); } catch (e) {}
    }

    if (mode === 'manual' && targetKb > 0 && outSize > targetKb * 1024) {
      const minKb = Math.round(outSize / 1024);
      safeUnlink(input);
      safeUnlink(out);
      return res.status(422).json({
        error: `Could not compress image below ${targetKb} KB without excessive quality loss. The smallest achievable size was ${minKb} KB.`,
        achievedKb: minKb,
        targetKb: targetKb
      });
    }

    // When the user picked a different output format the converted file must be returned even if it is larger than
    // the original; otherwise the untouched original would be sent under the new extension.
    const inExt = path.extname(originalName).slice(1).toLowerCase().replace('jpeg', 'jpg');
    const formatChanged = targetExt.replace('jpeg', 'jpg') !== inExt;
    const useCompressed = outSize > 0 && (mode === 'manual' || formatChanged || outSize < inSize);
    const finalSize = useCompressed ? outSize : inSize;
    const bytesSaved = Math.max(0, inSize - finalSize);
    const reductionPct = inSize > 0 ? Math.round((bytesSaved / inSize) * 100) : 0;

    res.set({
      'X-Original-Size': String(inSize),
      'X-Result-Size': String(finalSize),
      'X-Bytes-Saved': String(bytesSaved),
      'X-Reduction-Pct': String(reductionPct),
      'X-Already-Optimized': useCompressed ? '0' : '1',
      'X-Target-Size-KB': targetKb > 0 ? String(targetKb) : '0',
      'X-Target-Met': mode === 'manual' ? (outSize <= targetKb * 1024 ? '1' : '0') : '1'
    });

    const downloadName = `${path.parse(originalName).name}_compressed.${targetExt}`;
    downloadAndClean(res, useCompressed ? out : input, downloadName, [input, out]);
  } catch (err) {
    safeUnlink(input);
    safeUnlink(out);
    console.error('Image compress error:', err);
    res.status(500).json({ error: err.message || 'Failed to compress image. Please ensure the file is a valid image.' });
  }
});

// PDF COMPRESSOR (Multi-profile PyMuPDF + Pillow downsampler)
app.post('/api/pdf/compress', security.concurrencyLimiter, gatedUpload.single('file'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  const tmp = [];
  const level = String(req.body.level || 'recommended');
  const gray = req.body.gray === '1' || req.body.gray === 'true' ? '1' : '0';

  try {
    const inSize = fs.statSync(input).size;
    const out = newOutPath('compressed', 'pdf');
    tmp.push(out);

    // Primary: High-efficiency real PyMuPDF + Pillow image downsampling engine
    try {
      await runRealTool('compress_pdf', input, out, [level, gray]);
    } catch (pyErr) {
      fallbackNotice(res, 'Real tool compress', pyErr);
      const s = COMPRESS_PRESETS[level] || COMPRESS_PRESETS.recommended;
      await execFileP('gs', gsCompressArgs(input, out, s, gray === '1'), { timeout: 120000 });
    }

    if (!fs.existsSync(out)) throw new Error('Compression produced no output.');
    const compSize = fs.statSync(out).size;
    const useCompressed = compSize > 0 && compSize < inSize;
    const finalSize = useCompressed ? compSize : inSize;
    const bytesSaved = Math.max(0, inSize - finalSize);
    const reductionPct = inSize > 0 ? Math.round((bytesSaved / inSize) * 100) : 0;

    res.set({
      'X-Original-Size': String(inSize),
      'X-Result-Size': String(finalSize),
      'X-Bytes-Saved': String(bytesSaved),
      'X-Reduction-Pct': String(reductionPct),
      'X-Already-Optimized': useCompressed ? '0' : '1'
    });

    const name = `${path.parse(req.file.originalname).name}_compressed.pdf`;
    downloadAndClean(res, useCompressed ? out : input, name, [input, ...tmp]);
  } catch (err) {
    safeUnlink(input);
    tmp.forEach(safeUnlink);
    console.error('Compress error:', err.stderr || err);
    res.status(500).json({ error: 'Could not compress this PDF. If it is password-protected, unlock it first.' });
  }
});

// 7. REPAIR PDF (Staged recovery parser & verification pipeline)
app.post('/api/pdf/repair', security.concurrencyLimiter, gatedUpload.single('file'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  const output = newOutPath('repaired', 'pdf');
  const name = `${path.parse(req.file.originalname).name}_repaired.pdf`;

  try {
    const inSize = fs.statSync(input).size;
    let pageCount = 1;
    let wasCorrupted = false;

    // Check header signature
    const headerBuf = Buffer.alloc(1024);
    const fd = fs.openSync(input, 'r');
    fs.readSync(fd, headerBuf, 0, 1024, 0);
    fs.closeSync(fd);
    if (!headerBuf.toString('latin1').includes('%PDF-')) {
      wasCorrupted = true;
    }

    const { stdout } = await runRealTool('repair_pdf', input, output);
    if (!fs.existsSync(output) || fs.statSync(output).size < 50) {
      throw new Error('Repair produced no output.');
    }

    const outSize = fs.statSync(output).size;
    const mMatch = stdout.match(/METRICS:(.+)/);
    if (mMatch) {
      try {
        const m = JSON.parse(mMatch[1]);
        pageCount = m.pages || pageCount;
        if (m.was_corrupted !== undefined) {
          wasCorrupted = Boolean(m.was_corrupted);
        }
      } catch (e) {}
    }

    res.set({
      'X-Repair-Status': wasCorrupted ? 'repaired' : 'already_valid',
      'X-Page-Count': String(pageCount),
      'X-Original-Size': String(inSize),
      'X-Repaired-Size': String(outSize)
    });

    downloadAndClean(res, output, name, [input]);
  } catch (err) {
    safeUnlink(input);
    safeUnlink(output);
    console.error('Repair error:', err.stderr || err);
    res.status(500).json({ error: 'This PDF is too damaged to repair.' });
  }
});

// 8. PROTECT PDF (High-fidelity PyMuPDF AES-256 encryption engine with fallback)
app.post('/api/pdf/protect', security.concurrencyLimiter, gatedUpload.single('file'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  const output = newOutPath('protected', 'pdf');
  const password = String(req.body.password || '');

  if (password.length < 1 || password.length > 100) {
    safeUnlink(input);
    return res.status(400).json({ error: 'Enter a password (up to 100 characters).' });
  }

  try {
    let success = false;
    let metrics = {};

    // First attempt: PyMuPDF native AES-256
    try {
      const { stdout } = await runRealTool('protect_pdf', input, output, [password]);
      if (fs.existsSync(output) && fs.statSync(output).size > 50) {
        success = true;
        const mMatch = stdout.match(/METRICS:(.+)/);
        if (mMatch) {
          try { metrics = JSON.parse(mMatch[1]); } catch (e) {}
        }
      }
    } catch (toolErr) {
      const toolMsg = String((toolErr && (toolErr.stderr || toolErr.message)) || '');
      if (/already encrypted/i.test(toolMsg)) {
        safeUnlink(input);
        safeUnlink(output);
        return res.status(400).json({ error: 'This PDF already has a password. Unlock it first, then protect it again.' });
      }
      // If PyMuPDF failed for other reasons, try qpdf fallback if present
      console.warn('PyMuPDF protect failed, attempting qpdf fallback:', toolMsg);
      try {
        await runQpdf(['--encrypt', password, password, '256', '--', input, output]);
        if (fs.existsSync(output) && fs.statSync(output).size > 50) {
          success = true;
        }
      } catch (qErr) {
        throw toolErr;
      }
    }

    if (!success || !fs.existsSync(output)) {
      throw new Error('Protection failed to generate encrypted output.');
    }

    res.set({
      'X-Encryption-Algorithm': 'AES-256',
      'X-Page-Count': String(metrics.pages || 1)
    });

    downloadAndClean(res, output, `${path.parse(req.file.originalname).name}_protected.pdf`, [input]);
  } catch (err) {
    safeUnlink(input);
    safeUnlink(output);
    const msg = String((err && (err.stderr || err.message)) || err);
    console.error('Protect error:', msg);
    if (/already encrypted/i.test(msg) || /invalid password/i.test(msg)) {
      return res.status(400).json({ error: 'This PDF already has a password. Unlock it first, then protect it again.' });
    }
    res.status(500).json({ error: 'Could not protect this PDF. Please verify the document is not corrupted.' });
  }
});

// 9. UNLOCK PDF (High-fidelity PyMuPDF decryption engine with fallback)
app.post('/api/pdf/unlock', security.concurrencyLimiter, gatedUpload.single('file'), async (req, res) => {
  if (!requirePdf(req, res, true)) return;

  const input = req.file.path;
  const output = newOutPath('unlocked', 'pdf');
  const password = String(req.body.password || '');

  try {
    let success = false;
    let metrics = {};

    // First attempt: PyMuPDF native unlock
    try {
      const { stdout } = await runRealTool('unlock_pdf', input, output, [password]);
      if (fs.existsSync(output) && fs.statSync(output).size > 50) {
        success = true;
        const mMatch = stdout.match(/METRICS:(.+)/);
        if (mMatch) {
          try { metrics = JSON.parse(mMatch[1]); } catch (e) {}
        }
      }
    } catch (toolErr) {
      const toolMsg = String((toolErr && (toolErr.stderr || toolErr.message)) || '');
      if (/Incorrect password/i.test(toolMsg)) {
        safeUnlink(input);
        safeUnlink(output);
        return res.status(400).json({
          error: password
            ? 'That password is not correct for this PDF.'
            : 'This PDF needs a password to open. Enter it above and try again.'
        });
      }
      // If PyMuPDF failed for other reasons, try qpdf fallback if present
      console.warn('PyMuPDF unlock failed, attempting qpdf fallback:', toolMsg);
      try {
        const args = ['--decrypt'];
        if (password) args.push(`--password=${password}`);
        args.push(input, output);
        await runQpdf(args);
        if (fs.existsSync(output) && fs.statSync(output).size > 50) {
          success = true;
        }
      } catch (qErr) {
        throw toolErr;
      }
    }

    if (!success || !fs.existsSync(output)) {
      throw new Error('Unlock failed to generate decrypted output.');
    }

    res.set({
      'X-Unlock-Status': metrics.was_encrypted ? 'decrypted' : 'already_unencrypted',
      'X-Page-Count': String(metrics.pages || 1)
    });

    downloadAndClean(res, output, `${path.parse(req.file.originalname).name}_unlocked.pdf`, [input]);
  } catch (err) {
    safeUnlink(input);
    safeUnlink(output);
    const msg = String((err && (err.stderr || err.message)) || err);
    console.error('Unlock error:', msg);
    if (/Incorrect password/i.test(msg) || /invalid password/i.test(msg)) {
      return res.status(400).json({
        error: password
          ? 'That password is not correct for this PDF.'
          : 'This PDF needs a password to open. Enter it above and try again.'
      });
    }
    res.status(500).json({ error: 'Could not unlock this PDF. Please verify the document and password.' });
  }
});

// 10. SCAN PDF (Page analysis, deskew, contrast & PyMuPDF searchable OCR engine)
app.post('/api/pdf/scan', security.concurrencyLimiter, gatedUpload.single('file'), async (req, res) => {
  if (!requirePdf(req, res)) return;

  const input = req.file.path;
  const output = newOutPath('scanned', 'pdf');
  const lang = String(req.body.lang || 'eng').trim().toLowerCase();
  const mode = String(req.body.mode || 'smart').trim().toLowerCase();

  try {
    const inSize = fs.statSync(input).size;
    const { stdout } = await runRealTool('scan_pdf', input, output, [lang, mode]);

    if (!fs.existsSync(output) || fs.statSync(output).size < 100) {
      throw new Error('Scan PDF produced no valid output.');
    }

    const outSize = fs.statSync(output).size;
    let metrics = {};
    const mMatch = stdout.match(/METRICS:(.+)/);
    if (mMatch) {
      try { metrics = JSON.parse(mMatch[1]); } catch (e) {}
    }

    res.set({
      'X-Original-Size': String(inSize),
      'X-Result-Size': String(outSize),
      'X-Total-Pages': String(metrics.total_pages || 1),
      'X-Scanned-Pages': String(metrics.scanned_pages || 0),
      'X-Native-Pages': String(metrics.native_pages || 0),
      'X-Words-Added': String(metrics.words_added || 0)
    });

    const downloadName = `${path.parse(req.file.originalname).name}_scanned.pdf`;
    downloadAndClean(res, output, downloadName, [input]);
  } catch (err) {
    safeUnlink(input);
    safeUnlink(output);
    console.error('Scan PDF error:', err.stderr || err.message || err);
    res.status(500).json({ error: err.message || 'Could not scan this PDF. If password-protected, unlock it first.' });
  }
});

// 11. ENHANCE IMAGE (OpenCV + Pillow High-Fidelity Image Enhancement)
app.post('/api/image/enhance', security.concurrencyLimiter, gatedUpload.single('file'), async (req, res) => {
  if (!await validateUploadSafety(req, res, 'image')) return;

  const input = req.file.path;
  const originalName = req.file.originalname;
  const preset = String(req.body.preset || 'balanced').trim().toLowerCase();
  const sharpen = String(req.body.sharpen || 'medium').trim().toLowerCase();
  const denoise = String(req.body.denoise || 'mild').trim().toLowerCase();
  const contrast = req.body.contrast === '0' || req.body.contrast === 'false' ? '0' : '1';
  const brightness = String(req.body.brightness || '0').trim();
  const saturation = String(req.body.saturation || '1.0').trim();
  const scale = String(req.body.scale || '1.0').trim();
  const format = String(req.body.format || 'default').trim().toLowerCase();

  let targetExt = path.extname(originalName).slice(1).toLowerCase();
  if (format === 'jpeg' || format === 'jpg') targetExt = 'jpg';
  else if (format === 'png') targetExt = 'png';
  else if (format === 'webp') targetExt = 'webp';
  if (!targetExt) targetExt = 'jpg';

  const output = newOutPath('enhanced_img', targetExt);

  try {
    const inSize = fs.statSync(input).size;
    const { stdout } = await runRealTool('enhance_image', input, output, [
      preset,
      sharpen,
      denoise,
      contrast,
      brightness,
      saturation,
      scale,
      format
    ]);

    if (!fs.existsSync(output) || fs.statSync(output).size < 100) {
      throw new Error('Enhance image produced no valid output.');
    }

    const outSize = fs.statSync(output).size;
    let metrics = {};
    const mMatch = stdout.match(/METRICS:(.+)/);
    if (mMatch) {
      try { metrics = JSON.parse(mMatch[1]); } catch (e) {}
    }

    res.set({
      'X-Original-Size': String(inSize),
      'X-Result-Size': String(outSize),
      'X-Original-W': String(metrics.original_w || 0),
      'X-Original-H': String(metrics.original_h || 0),
      'X-Output-W': String(metrics.output_w || 0),
      'X-Output-H': String(metrics.output_h || 0),
      'X-Format': String(metrics.format || targetExt)
    });

    const downloadName = `${path.parse(originalName).name}_enhanced.${targetExt}`;
    downloadAndClean(res, output, downloadName, [input]);
  } catch (err) {
    safeUnlink(input);
    safeUnlink(output);
    console.error('Enhance image error:', err.stderr || err.message || err);
    res.status(500).json({ error: err.message || 'Failed to enhance image. Please ensure the file is a valid image.' });
  }
});

// Centralized Multer and upload limit error handler (maps LIMIT_FILE_SIZE to HTTP 413)
app.use(security.handleMulterError);

// Custom 404 Handler for unknown routes
app.use((req, res) => {
  res.status(404);
  if (req.accepts('html')) {
    const p404 = path.join(__dirname, '404.html');
    if (fs.existsSync(p404)) {
      res.sendFile(p404);
    } else {
      res.type('html').send('<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1><p>The requested page does not exist. <a href="/">Return to Fileora</a></p></body></html>');
    }
  } else if (req.accepts('json')) {
    res.json({ error: 'Page or resource not found.' });
  } else {
    res.type('txt').send('404 Not Found');
  }
});

app.listen(PORT, () => {
  console.log(`Fileora conversion engine listening on port ${PORT}`);
  // One startup line for the platform logs: runtime facts and which backends are configured (booleans only, no values)
  let sqliteOk = false; try { require('node:sqlite'); sqliteOk = true; } catch (e) {}
  console.log(`[startup] node=${process.version} platform=${process.platform}/${process.arch} node:sqlite=${sqliteOk} r2Configured=${r2Storage.isR2Configured} d1Configured=${r2Storage.isD1Configured} geminiKey=${Boolean(process.env.GEMINI_API_KEY)} smtpPass=${Boolean(process.env.SMTP_PASS)} heavyConcurrency=${process.env.HEAVY_CONCURRENCY || 1}`);
  // Job records must live somewhere reliable. With REQUIRE_D1=true a missing or unusable D1 stops the process (a failed
  // deploy keeps the previous version running) instead of serving jobs that cannot be found later.
  if (r2Storage.isD1Configured) { const c = r2Storage.d1ConfigDiagnostics; console.log(`[startup] d1 config: accountIdSource=${c.accountIdSource} accountIdLength=${c.accountIdLength} accountIdFormatOk=${c.accountIdFormatOk} databaseIdFormatOk=${c.databaseIdFormatOk}`); }
  r2Storage.verifyR2().then((r) => console.log(`[startup] r2 check: ${r.ok ? 'ok' : 'PROBLEM'} - ${r.reason}`)).catch(() => {});
  r2Storage.verifyPersistence().then((st) => {
    console.log(`[startup] job database: ${st.ok ? 'ok' : 'PROBLEM'} - ${st.reason}`);
    if (!st.ok && process.env.REQUIRE_D1 === 'true') {
      console.error('[startup] REQUIRE_D1=true and the job database is not usable: exiting so this deploy fails instead of losing jobs.');
      process.exit(1);
    }
  }).catch(() => {});
});
