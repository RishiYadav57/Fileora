/**
 * Centralized Security, Abuse Prevention & Upload Limits Policy
 * Enforces strict upload limits, rate limiting, concurrency controls,
 * magic byte validation, archive bomb defense, and output protection.
 */

const fs = require('fs');
const path = require('path');
const multer = require('multer');

// 1. Centralized Policy Constants (Binary MiB)
const LIMITS = {
  MAX_FILE_SIZE_BYTES: 10 * 1000 * 1000,       // 10 MB (decimal) = 10,000,000 bytes per file, also inside batches
  MAX_BATCH_SIZE_BYTES: 20 * 1000 * 1000,      // 20 MB (decimal) = 20,000,000 bytes combined per batch
  MAX_FILES_PER_BATCH: 3,                      // Up to 3 files per batch
  MAX_CONCURRENT_PER_IP: 2,                    // Max 2 active conversions per IP
  MAX_OUTPUT_SIZE_BYTES: 100 * 1024 * 1024,    // 100 MiB max generated output
  RATE_LIMIT_WINDOW_MS: 60 * 1000,             // 1 minute window
  MAX_CONVERSIONS_PER_MIN: 25,                 // 25 conversion requests/min per IP
  MAX_GENERAL_REQ_PER_MIN: 120,                // 120 general requests/min per IP
  MAX_UNCOMPRESSED_ARCHIVE_BYTES: 200 * 1024 * 1024, // 200 MiB max decompressed
  MAX_ARCHIVE_ENTRIES: 5000,                   // Max 5000 entries inside archive
  MAX_COMPRESSION_RATIO: 100,                  // 100:1 ratio limit (bomb defense)
  CONVERSION_TIMEOUT_MS: 90 * 1000             // 90 seconds timeout
};

// 2. Concurrency Tracker (Max 2 simultaneous conversions per IP)
const activeConversionsByIp = new Map();

function trackConversionStart(ip) {
  const current = activeConversionsByIp.get(ip) || 0;
  if (current >= LIMITS.MAX_CONCURRENT_PER_IP) {
    return false;
  }
  activeConversionsByIp.set(ip, current + 1);
  return true;
}

function trackConversionEnd(ip) {
  const current = activeConversionsByIp.get(ip) || 0;
  if (current <= 1) {
    activeConversionsByIp.delete(ip);
  } else {
    activeConversionsByIp.set(ip, current - 1);
  }
}

function concurrencyLimiter(req, res, next) {
  const clientIp = getClientIp(req);
  if (!trackConversionStart(clientIp)) {
    return res.status(429).json({
      error: 'CONCURRENCY_LIMIT_EXCEEDED',
      message: `Maximum ${LIMITS.MAX_CONCURRENT_PER_IP} simultaneous conversions allowed. Please wait for your active conversions to complete.`
    });
  }

  let finished = false;
  const cleanup = () => {
    if (!finished) {
      finished = true;
      trackConversionEnd(clientIp);
    }
  };

  res.on('finish', cleanup);
  res.on('close', cleanup);
  // One shared gate for all heavy routes: bounded admission, limited concurrency, cancel-aware (see jobgate.js).
  // File uploads are admitted here (before the body is read) and enter the run queue after multer has stored them
  // (heavyGate below), so a client that leaves while queued is noticed and its upload is removed.
  const gate = require('./jobgate');
  if (!gate.admit(req, res)) return;
  if (/multipart\/form-data/i.test(req.headers['content-type'] || '')) return next();
  gate.enter(req, res, next);
}

function heavyGate(req, res, next) { require('./jobgate').enter(req, res, next); }

// 3. Sliding-Window Rate Limiter
const rateLimitBuckets = new Map();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = forwarded.split(',').map(s => s.trim());
    if (ips[0]) return ips[0];
  }
  return req.socket ? req.socket.remoteAddress || '127.0.0.1' : '127.0.0.1';
}

function rateLimiter(isConversion = false) {
  const maxReq = isConversion ? LIMITS.MAX_CONVERSIONS_PER_MIN : LIMITS.MAX_GENERAL_REQ_PER_MIN;
  return (req, res, next) => {
    const ip = getClientIp(req);
    const key = `${isConversion ? 'conv:' : 'gen:'}${ip}`;
    const now = Date.now();

    let bucket = rateLimitBuckets.get(key);
    if (!bucket || now > bucket.resetTime) {
      bucket = { count: 1, resetTime: now + LIMITS.RATE_LIMIT_WINDOW_MS };
      rateLimitBuckets.set(key, bucket);
    } else {
      bucket.count++;
      if (bucket.count > maxReq) {
        return res.status(429).json({
          error: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please slow down and try again.'
        });
      }
    }
    next();
  };
}

// Periodic cleanup of stale rate-limit buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of rateLimitBuckets.entries()) {
    if (now > b.resetTime) rateLimitBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

// 4. Centralized Multer Storage & Pre-Processing Limits
const uploadDir = path.join(require('os').tmpdir(), 'fileconverter-uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const secureMulterStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const cleanName = path.basename(file.originalname).replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${uniqueSuffix}-${cleanName}`);
  }
});

// Multer upload instances enforcing the 10 MB individual file size limit
const singleUpload = multer({
  storage: secureMulterStorage,
  limits: {
    fileSize: LIMITS.MAX_FILE_SIZE_BYTES + 1, // +1: multer rejects at >= limit
    files: 1
  }
}).single('file');

const arrayUpload = multer({
  storage: secureMulterStorage,
  limits: {
    fileSize: LIMITS.MAX_FILE_SIZE_BYTES + 1, // +1: multer rejects at >= limit
    files: LIMITS.MAX_FILES_PER_BATCH      // Up to 3 files
  }
}).array('files', LIMITS.MAX_FILES_PER_BATCH);

// 5. Middleware to validate combined batch size and reject oversized payloads
function validateBatchSize(req, res, next) {
  const files = req.files || (req.file ? [req.file] : []);
  if (!files.length) return next();

  if (files.length > LIMITS.MAX_FILES_PER_BATCH) {
    files.forEach(f => safeUnlink(f.path));
    return res.status(413).json({
      error: 'TOO_MANY_FILES',
      message: `Maximum ${LIMITS.MAX_FILES_PER_BATCH} files per batch.`
    });
  }

  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.size || 0;
  }

  if (totalBytes > LIMITS.MAX_BATCH_SIZE_BYTES) {
    files.forEach(f => safeUnlink(f.path));
    return res.status(413).json({
      error: 'BATCH_TOO_LARGE',
      message: 'Maximum combined batch size is 20 MB.'
    });
  }

  next();
}

// 6. Magic Bytes / File Signature Verification
const MAGIC_SIGNATURES = {
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
  zip: [0x50, 0x4B, 0x03, 0x04], // PK.. (DOCX, PPTX, XLSX, ZIP)
  png: [0x89, 0x50, 0x4E, 0x47], // .PNG
  jpeg: [0xFF, 0xD8, 0xFF],      // JPEG
  gif: [0x47, 0x49, 0x46, 0x38], // GIF8
};

function verifyFileSignature(filePath, expectedType) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const ext = path.extname(filePath).toLowerCase();
    if (expectedType === 'office' && (ext === '.csv' || ext === '.txt')) {
      return true;
    }

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);

    if (expectedType === 'pdf') {
      return buf.slice(0, 4).equals(Buffer.from(MAGIC_SIGNATURES.pdf));
    }
    if (expectedType === 'office' || expectedType === 'zip') {
      const isZip = buf.slice(0, 4).equals(Buffer.from(MAGIC_SIGNATURES.zip));
      // Legacy binary MS Office files (DOC, PPT, XLS: 0xD0, 0xCF, 0x11, 0xE0)
      const isLegacyOffice = buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0;
      return isZip || isLegacyOffice;
    }
    if (expectedType === 'image') {
      const isPng = buf.slice(0, 4).equals(Buffer.from(MAGIC_SIGNATURES.png));
      const isJpeg = buf.slice(0, 3).equals(Buffer.from(MAGIC_SIGNATURES.jpeg));
      const isGif = buf.slice(0, 4).equals(Buffer.from(MAGIC_SIGNATURES.gif));
      const isWebp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
      return isPng || isJpeg || isGif || isWebp;
    }
    return true;
  } catch (err) {
    return false;
  }
}

// 7. Archive Bomb & Malicious Archive Verification
async function inspectArchiveSafety(filePath) {
  try {
    const JSZip = require('jszip');
    const data = fs.readFileSync(filePath);
    const zip = await JSZip.loadAsync(data, { checkCRC32: false });

    let entryCount = 0;
    let totalUncompressed = 0;

    for (const [filename, fileObj] of Object.entries(zip.files)) {
      entryCount++;
      if (entryCount > LIMITS.MAX_ARCHIVE_ENTRIES) {
        return { safe: false, reason: `Archive contains too many entries (> ${LIMITS.MAX_ARCHIVE_ENTRIES})` };
      }

      // Check path traversal
      if (filename.includes('..') || filename.startsWith('/') || filename.startsWith('\\')) {
        return { safe: false, reason: 'Malicious path traversal detected inside archive' };
      }

      const uncompressed = fileObj._data ? fileObj._data.uncompressedSize || 0 : 0;
      totalUncompressed += uncompressed;

      if (totalUncompressed > LIMITS.MAX_UNCOMPRESSED_ARCHIVE_BYTES) {
        return { safe: false, reason: 'Decompressed size exceeds 200 MiB safety limit' };
      }
    }

    if (data.length > 0 && totalUncompressed > 0) {
      const ratio = totalUncompressed / data.length;
      if (ratio > LIMITS.MAX_COMPRESSION_RATIO && totalUncompressed > 10 * 1024 * 1024) {
        return { safe: false, reason: `Suspicious compression ratio (${ratio.toFixed(0)}:1) indicates archive bomb` };
      }
    }

    return { safe: true };
  } catch (err) {
    // If not a valid zip archive, allow parent error handler to handle
    return { safe: true };
  }
}

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {}
}

// 8. Centralized Multer Error Handler
// Rejects a multipart request whose declared size already exceeds the batch limit, before any bytes are stored.
// (Declared length is only an early hint; the real byte counts are still enforced by multer and validateBatchSize.)
function rejectOversizedRequest(req, res, next) {
  if (req.method === 'POST' && /multipart\/form-data/i.test(req.headers['content-type'] || '')) {
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    const isBatch = /\/pdf\/merge/.test(req.originalUrl || req.url || '');
    const cap = (isBatch ? LIMITS.MAX_BATCH_SIZE_BYTES : LIMITS.MAX_FILE_SIZE_BYTES) + 1000 * 1000; // + multipart framing
    if (declared > cap) {
      const reply = () => { if (!res.headersSent) res.status(413).json(isBatch
        ? { error: 'BATCH_TOO_LARGE', message: 'Maximum combined batch size is 20 MB.' }
        : { error: 'FILE_TOO_LARGE', message: 'Maximum file size is 10 MB.' }); };
      // Discard the body without storing it, then answer, so the browser gets the message instead of a reset connection.
      // Beyond 200 MB, answer at once and let the connection close.
      if (declared > 200 * 1000 * 1000) { res.setHeader('Connection', 'close'); return reply(); }
      req.on('end', reply);
      req.on('error', () => {});
      return req.resume();
    }
  }
  next();
}

function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'FILE_TOO_LARGE',
        message: /\/pdf\/merge/.test(req.path || req.originalUrl || '') ? 'Each file must be 10 MB or smaller.' : 'Maximum file size is 10 MB.'
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(413).json({
        error: 'TOO_MANY_FILES',
        message: 'Maximum 3 files per batch.'
      });
    }
    return res.status(400).json({ error: 'UPLOAD_ERROR', message: 'The upload could not be processed. Please check the files and try again.' });
  } else if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'REQUEST_TOO_LARGE', message: 'The request is too large.' });
  } else if (err) {
    console.error('[upload] failed:', err.message);
    return res.status(400).json({ error: 'UPLOAD_FAILED', message: 'The upload could not be processed. Please try again.' });
  }
  next();
}

module.exports = {
  LIMITS,
  singleUpload,
  arrayUpload,
  validateBatchSize,
  concurrencyLimiter,
  heavyGate,
  rateLimiter,
  verifyFileSignature,
  inspectArchiveSafety,
  handleMulterError,
  rejectOversizedRequest,
  safeUnlink
};
