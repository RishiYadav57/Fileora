/**
 * Cloudflare R2 & Ephemeral Storage Engine for Fileora (pdfconverterfree.in)
 * Provides refresh-safe, multi-tenant secure temporary file storage, configurable retention,
 * server-side expiry authorization, orphaned object sweeps, and automated multi-phase cleanup.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');

// Load environment variables from .env if present (zero-dependency)
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      content.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
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
    } catch (e) {}
  }
})();

// Helper to safely parse and clamp positive integers from environment variables
function parsePositiveInt(val, fallback, min = 1, max = 10080) {
  if (val === undefined || val === null || val === '') return fallback;
  const parsed = parseInt(val, 10);
  if (isNaN(parsed) || parsed < min || parsed > max) {
    console.warn(`[Storage Config] Invalid value "${val}" (min: ${min}, max: ${max}). Falling back to default: ${fallback}`);
    return fallback;
  }
  return parsed;
}

// 1. Environment & Configurable Retention Targets
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'fileconverter-temp';
const R2_ENDPOINT = process.env.R2_ENDPOINT || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '');
const REQUIRE_CLOUD_STORAGE = process.env.REQUIRE_CLOUD_STORAGE === 'true';

// Retention targets (with units and fallback validation):
// Converted outputs: 60 minutes initial target (supports OUTPUT_RETENTION_MINUTES or backwards-compatible STORAGE_RETENTION_HOURS)
const rawOutputMin = process.env.OUTPUT_RETENTION_MINUTES ||
  (process.env.STORAGE_RETENTION_HOURS ? String(parseInt(process.env.STORAGE_RETENTION_HOURS, 10) * 60) : '60');
const OUTPUT_RETENTION_MINUTES = parsePositiveInt(rawOutputMin, 60, 5, 10080); // Default 60 min (1 hour), min 5 min, max 7 days

// Failed or abandoned jobs retention: 15 minutes default
const FAILED_JOB_RETENTION_MINUTES = parsePositiveInt(process.env.FAILED_JOB_RETENTION_MINUTES, 15, 1, 1440);

// In-process cleanup interval: 10 minutes default (keeps worst-case delay capped at retention + 10 min)
const CLEANUP_INTERVAL_MINUTES = parsePositiveInt(process.env.CLEANUP_INTERVAL_MINUTES, 10, 1, 1440);

// Orphaned R2 objects threshold before deletion: default 24 hours
const ORPHAN_CLEANUP_HOURS = parsePositiveInt(process.env.ORPHAN_CLEANUP_HOURS, 24, 1, 168);

// Stale local temporary directory retention: default 15 minutes
const LOCAL_TEMP_RETENTION_MINUTES = parsePositiveInt(process.env.LOCAL_TEMP_RETENTION_MINUTES, 15, 5, 1440);

// Cleanup query batch size to bound memory and CPU usage
const CLEANUP_BATCH_SIZE = parsePositiveInt(process.env.CLEANUP_BATCH_SIZE, 50, 5, 500);

// Admin secret for triggering authenticated /api/admin/cleanup endpoint
const CLEANUP_ADMIN_SECRET = process.env.CLEANUP_ADMIN_SECRET || '';

// Optional D1 configuration (NOT required; SQLite fallback is fully self-contained)
const D1_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.R2_ACCOUNT_ID || '';
const D1_DATABASE_ID = process.env.D1_DATABASE_ID || '';
const D1_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';

const isPlaceholderSecret = !R2_SECRET_ACCESS_KEY || 
  R2_SECRET_ACCESS_KEY.toLowerCase().includes('placeholder') || 
  R2_SECRET_ACCESS_KEY.toLowerCase().includes('your_r2_secret');

const isR2Configured = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && !isPlaceholderSecret);
const isD1Configured = Boolean(D1_ACCOUNT_ID && D1_DATABASE_ID && D1_API_TOKEN);

// Initialize R2 S3 Client (if configured)
let s3Client = null;
if (isR2Configured) {
  try {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY
      }
    });
  } catch (err) {
    console.error('[Storage] Error initializing S3Client:', err.message);
  }
}

// 2. MIME Type Lookup Table
const MIME_MAP = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8'
};

function getMimeType(filename, defaultMime = 'application/octet-stream') {
  const ext = path.extname(filename || '').toLowerCase();
  return MIME_MAP[ext] || defaultMime;
}

function sanitizeFilename(filename) {
  const base = path.basename(filename || 'converted_file');
  return base.replace(/[^a-zA-Z0-9._\-]/g, '_');
}

// 3. Embedded SQLite Engine (Node.js native DatabaseSync)
let localDb = null;
function getLocalDb() {
  if (localDb) return localDb;
  const storageDir = path.join(__dirname, 'storage');
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    // Node older than 22.5 has no built-in SQLite: fail with a clear operator message instead of a bare MODULE_NOT_FOUND
    throw new Error(`Local job database unavailable: this Node.js (${process.version}) has no node:sqlite (needs 22.5+). Use a newer Node image or configure Cloudflare D1.`);
  }
  const dbPath = path.join(storageDir, 'jobs.sqlite');
  localDb = new DatabaseSync(dbPath);
  localDb.exec(`
    CREATE TABLE IF NOT EXISTS conversion_jobs (
      job_id TEXT PRIMARY KEY,
      download_token TEXT NOT NULL,
      object_key TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      converted_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON conversion_jobs(expires_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON conversion_jobs(status);
  `);
  return localDb;
}

// 4. Database Query Executor (D1 if configured, otherwise built-in SQLite)
async function executeD1Query(sql, params = []) {
  if (!isD1Configured) {
    const db = getLocalDb();
    const isSelect = sql.trim().toUpperCase().startsWith('SELECT');
    const stmt = db.prepare(sql);
    if (isSelect) {
      return stmt.all(...params);
    } else {
      stmt.run(...params);
      return [];
    }
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${D1_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${D1_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sql, params })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Cloudflare D1 query failed (${res.status}): ${errText}`);
  }

  const json = await res.json();
  if (!json.success) {
    throw new Error(`D1 API error: ${JSON.stringify(json.errors || json)}`);
  }

  const result = json.result && json.result[0];
  return (result && result.results) || [];
}

let d1Initialized = false;
async function initD1IfNeeded() {
  if (d1Initialized) return;
  try {
    await executeD1Query(`
      CREATE TABLE IF NOT EXISTS conversion_jobs (
        job_id TEXT PRIMARY KEY,
        download_token TEXT NOT NULL,
        object_key TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        converted_filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    await executeD1Query(`CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON conversion_jobs(expires_at);`);
    await executeD1Query(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON conversion_jobs(status);`);
    d1Initialized = true;
  } catch (err) {
    console.warn('[Storage] Notice during table verification:', err.message);
  }
}
initD1IfNeeded().catch(() => {});

// 5. Job Operations & Token Security
const JOB_ID_REGEX = /^cjob_[a-f0-9]{32}$/;
const TOKEN_REGEX = /^[a-f0-9]{64}$/;

function generateJobId() {
  return `cjob_${crypto.randomBytes(16).toString('hex')}`;
}

function generateDownloadToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Stores a converted file to Cloudflare R2 (or fallback storage) and saves its metadata with 60m retention.
 */
async function saveConvertedJob({ filePathOrBuffer, originalFilename, convertedFilename, mimeType, retentionMinutes }) {
  await initD1IfNeeded();

  const jobId = generateJobId();
  const downloadToken = generateDownloadToken();
  const safeOriginal = sanitizeFilename(originalFilename || 'document');
  const safeConverted = sanitizeFilename(convertedFilename || 'converted_file');
  const finalMime = mimeType || getMimeType(safeConverted);

  let fileSize = 0;
  let fileBuffer = null;

  if (Buffer.isBuffer(filePathOrBuffer)) {
    fileBuffer = filePathOrBuffer;
    fileSize = fileBuffer.length;
  } else if (typeof filePathOrBuffer === 'string') {
    const stats = fs.statSync(filePathOrBuffer);
    fileSize = stats.size;
    fileBuffer = fs.readFileSync(filePathOrBuffer);
  } else {
    throw new Error('Invalid file input: must be file path or Buffer.');
  }

  const MAX_OUTPUT_SIZE_BYTES = 100 * 1024 * 1024;
  if (fileSize > MAX_OUTPUT_SIZE_BYTES) {
    throw new Error(`Output file size (${(fileSize / (1024 * 1024)).toFixed(1)} MiB) exceeds maximum 100 MiB limit.`);
  }

  const objectKey = `converted/${jobId}/${safeConverted}`;

  // Upload to Cloudflare R2 if configured
  if (isR2Configured && s3Client) {
    try {
      const putCmd = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: objectKey,
        Body: fileBuffer,
        ContentType: finalMime,
        ContentLength: fileSize,
        Metadata: {
          'job-id': jobId,
          'original-filename': encodeURIComponent(safeOriginal)
        }
      });
      await s3Client.send(putCmd);
    } catch (r2Err) {
      console.error('[Storage] R2 Upload Error:', r2Err.message);
      throw new Error(`Cloudflare R2 upload failed: ${r2Err.message}`);
    }
  } else if (REQUIRE_CLOUD_STORAGE) {
    throw new Error('Cloud storage is required (REQUIRE_CLOUD_STORAGE=true), but Cloudflare R2 is not configured or secret key is missing.');
  } else {
    // Local storage fallback when R2 credentials are not set (local development mode only)
    const fallbackDir = path.join(__dirname, 'storage', 'files', jobId);
    fs.mkdirSync(fallbackDir, { recursive: true });
    fs.writeFileSync(path.join(fallbackDir, safeConverted), fileBuffer);
  }

  const now = Date.now();
  const minutes = retentionMinutes || OUTPUT_RETENTION_MINUTES;
  const expiresAt = now + (minutes * 60 * 1000);

  // Insert metadata into SQLite / D1
  await executeD1Query(
    `INSERT INTO conversion_jobs (
      job_id, download_token, object_key, original_filename, converted_filename, mime_type, file_size, status, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId,
      downloadToken,
      objectKey,
      safeOriginal,
      safeConverted,
      finalMime,
      fileSize,
      'completed',
      now,
      expiresAt
    ]
  );

  return {
    jobId,
    downloadToken,
    downloadUrl: `/download?id=${encodeURIComponent(jobId)}&token=${encodeURIComponent(downloadToken)}`,
    apiUrl: `/api/jobs/${encodeURIComponent(jobId)}/download?token=${encodeURIComponent(downloadToken)}`,
    filename: safeConverted,
    size: fileSize,
    mimeType: finalMime,
    expiresAt,
    retentionMinutes: minutes
  };
}

/**
 * Records a failed conversion job for audit and quick cleanup (15-minute retention).
 */
async function recordFailedJob({ jobId, originalFilename, error, retentionMinutes }) {
  await initD1IfNeeded();
  const id = jobId || generateJobId();
  const token = generateDownloadToken();
  const now = Date.now();
  const minutes = retentionMinutes || FAILED_JOB_RETENTION_MINUTES;
  const expiresAt = now + (minutes * 60 * 1000);

  try {
    await executeD1Query(
      `INSERT INTO conversion_jobs (
        job_id, download_token, object_key, original_filename, converted_filename, mime_type, file_size, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        token,
        '',
        sanitizeFilename(originalFilename || 'document'),
        'failed_conversion',
        'text/plain',
        0,
        'failed',
        now,
        expiresAt
      ]
    );
  } catch (e) {}

  return { jobId: id, expiresAt };
}

/**
 * Validates jobId, downloadToken, and server-side expiration.
 * Constant-time comparison protects against timing attacks.
 */
async function getAuthorizedJob(jobId, token) {
  if (!jobId || !JOB_ID_REGEX.test(jobId)) {
    return { error: 'INVALID_JOB_ID', status: 400, message: 'Invalid job ID format.' };
  }

  if (!token || !TOKEN_REGEX.test(token)) {
    return { error: 'INVALID_TOKEN', status: 400, message: 'Invalid or missing authorization token.' };
  }

  const rows = await executeD1Query(
    'SELECT * FROM conversion_jobs WHERE job_id = ? LIMIT 1',
    [jobId]
  );

  if (!rows || rows.length === 0) {
    return { error: 'NOT_FOUND', status: 404, message: 'Conversion job not found or has been deleted.' };
  }

  const job = rows[0];

  // Constant-time token comparison
  const tokenExpected = Buffer.from(job.download_token, 'hex');
  const tokenGiven = Buffer.from(token, 'hex');
  if (tokenExpected.length !== tokenGiven.length || !crypto.timingSafeEqual(tokenExpected, tokenGiven)) {
    return { error: 'UNAUTHORIZED', status: 403, message: 'Access denied: incorrect authorization token.' };
  }

  // Check server-side expiration (60-minute window)
  if (Date.now() > job.expires_at) {
    return {
      error: 'EXPIRED',
      status: 410,
      message: `This download link has expired. Converted files are retained for ${OUTPUT_RETENTION_MINUTES} minutes.`
    };
  }

  return { job };
}

/**
 * Gets a readable download stream for an authorized job.
 */
async function getJobDownloadStream(jobId, token) {
  const auth = await getAuthorizedJob(jobId, token);
  if (auth.error) {
    return auth;
  }

  const job = auth.job;

  if (isR2Configured && s3Client) {
    try {
      const getCmd = new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: job.object_key
      });
      const s3Res = await s3Client.send(getCmd);
      return {
        stream: s3Res.Body,
        job
      };
    } catch (r2Err) {
      console.error('[Storage] R2 GetObject error:', r2Err.message);
      if (r2Err.name === 'NoSuchKey' || r2Err.$metadata?.httpStatusCode === 404) {
        return { error: 'FILE_MISSING', status: 404, message: 'File is no longer present in storage.' };
      }
      return { error: 'STORAGE_ERROR', status: 502, message: 'Could not fetch file from Cloudflare R2.' };
    }
  } else if (REQUIRE_CLOUD_STORAGE) {
    return { error: 'STORAGE_UNAVAILABLE', status: 503, message: 'Cloud storage is required but Cloudflare R2 is not configured.' };
  } else {
    // Local fallback
    const localFilePath = path.join(__dirname, 'storage', 'files', job.job_id, job.converted_filename);
    if (!fs.existsSync(localFilePath)) {
      return { error: 'FILE_MISSING', status: 404, message: 'File is no longer present in storage.' };
    }
    const stream = fs.createReadStream(localFilePath);
    return { stream, job };
  }
}

/**
 * Explicitly deletes a specific job and its object from storage when requested by user.
 */
async function deleteJob(jobId, token) {
  const auth = await getAuthorizedJob(jobId, token);
  if (auth.error) return auth;
  const job = auth.job;

  if (isR2Configured && s3Client && job.object_key) {
    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: job.object_key
      }));
    } catch (e) {
      console.warn('[Storage] Delete R2 object notice:', e.message);
    }
  } else {
    try {
      const dir = path.join(__dirname, 'storage', 'files', job.job_id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {}
  }

  await executeD1Query('DELETE FROM conversion_jobs WHERE job_id = ?', [job.job_id]);
  return { success: true };
}

/**
 * Cleans up expired conversion jobs and their R2 objects in bounded batches.
 */
async function cleanExpiredJobs(batchSize = CLEANUP_BATCH_SIZE) {
  const now = Date.now();
  let totalPurged = 0;
  const maxIterations = 10; // Safety cap: max 10 batches per run

  for (let i = 0; i < maxIterations; i++) {
    const expiredRows = await executeD1Query(
      'SELECT job_id, object_key, converted_filename FROM conversion_jobs WHERE expires_at < ? LIMIT ?',
      [now, batchSize]
    );

    if (!expiredRows || expiredRows.length === 0) break;

    for (const row of expiredRows) {
      // 1. Delete from R2
      if (isR2Configured && s3Client && row.object_key) {
        try {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: row.object_key
          }));
        } catch (delErr) {
          if (delErr.name !== 'NoSuchKey' && delErr.$metadata?.httpStatusCode !== 404) {
            console.warn(`[Storage Cleanup] Notice deleting R2 object for ${row.job_id}:`, delErr.message);
          }
        }
      } else {
        // Local fallback cleanup
        try {
          const dir = path.join(__dirname, 'storage', 'files', row.job_id);
          if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        } catch (e) {}
      }

      // 2. Delete database record
      await executeD1Query('DELETE FROM conversion_jobs WHERE job_id = ?', [row.job_id]);
      totalPurged++;
    }

    if (expiredRows.length < batchSize) break;
  }

  return totalPurged;
}

/**
 * Scans R2 for orphaned objects that no longer have active database records and exceed safe age.
 */
async function cleanOrphanedR2Objects(maxKeys = 100) {
  if (!isR2Configured || !s3Client) return 0;

  let purgedOrphans = 0;
  try {
    const listCmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET_NAME,
      Prefix: 'converted/',
      MaxKeys: maxKeys
    });
    const s3Res = await s3Client.send(listCmd);
    const contents = s3Res.Contents || [];
    if (contents.length === 0) return 0;

    const safetyBufferMs = Math.max(OUTPUT_RETENTION_MINUTES, 15) * 60 * 1000;
    const now = Date.now();

    for (const obj of contents) {
      if (!obj.Key) continue;
      const parts = obj.Key.split('/');
      if (parts.length < 3) continue;
      const jobId = parts[1];

      // Age of object
      const ageMs = now - (obj.LastModified ? new Date(obj.LastModified).getTime() : now);
      if (ageMs < safetyBufferMs) continue; // Skip recent objects (could be mid-upload)

      // Check if job exists in database
      const rows = await executeD1Query('SELECT job_id, expires_at FROM conversion_jobs WHERE job_id = ? LIMIT 1', [jobId]);
      const shouldDelete = (rows.length === 0) || (rows[0].expires_at && rows[0].expires_at < now);

      if (shouldDelete) {
        try {
          await s3Client.send(new DeleteObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: obj.Key
          }));
          purgedOrphans++;
        } catch (delErr) {
          console.warn(`[Storage Cleanup] Orphan delete notice for ${obj.Key}:`, delErr.message);
        }
      }
    }
  } catch (err) {
    console.warn('[Storage Cleanup] Orphaned R2 sweep notice:', err.message);
  }

  return purgedOrphans;
}

/**
 * Sweeps local temporary directories for files older than LOCAL_TEMP_RETENTION_MINUTES.
 */
function cleanStaleTempFiles(extraDirs = []) {
  const dirsToClean = [
    path.join(os.tmpdir(), 'fileconverter-uploads'),
    path.join(os.tmpdir(), 'fileconverter-out'),
    path.join(os.tmpdir(), 'fileconverter-lo-profile'),
    path.join(__dirname, 'storage', 'files'),
    ...extraDirs
  ];

  const cutoff = Date.now() - (LOCAL_TEMP_RETENTION_MINUTES * 60 * 1000);
  let cleanedCount = 0;

  for (const dir of dirsToClean) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs < cutoff) {
            if (entry.isDirectory()) {
              fs.rmSync(fullPath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(fullPath);
            }
            cleanedCount++;
          }
        } catch (e) {}
      }
    } catch (e) {
      console.warn(`[Storage Cleanup] Stale temp scan notice for ${dir}:`, e.message);
    }
  }

  return cleanedCount;
}

/**
 * Master multi-phase cleanup coordinator.
 * Returns structured operational metrics and prevents overlapping execution.
 */
let isCleanupRunning = false;
async function runFullCleanup(extraDirs = []) {
  if (isCleanupRunning) {
    return { skipped: true, reason: 'CLEANUP_ALREADY_IN_PROGRESS' };
  }
  isCleanupRunning = true;
  const startTime = Date.now();

  try {
    const expiredJobs = await cleanExpiredJobs();
    const orphanedR2 = await cleanOrphanedR2Objects();
    const staleTempFiles = cleanStaleTempFiles(extraDirs);
    const durationMs = Date.now() - startTime;

    if (expiredJobs > 0 || orphanedR2 > 0 || staleTempFiles > 0) {
      console.log(`[Storage Cleanup] Swept ${expiredJobs} expired jobs, ${orphanedR2} orphaned R2 objects, ${staleTempFiles} stale temp files (${durationMs}ms).`);
    }

    return {
      success: true,
      timestamp: new Date().toISOString(),
      expiredJobs,
      orphanedR2,
      staleTempFiles,
      durationMs,
      retentionConfig: {
        outputRetentionMinutes: OUTPUT_RETENTION_MINUTES,
        failedRetentionMinutes: FAILED_JOB_RETENTION_MINUTES,
        cleanupIntervalMinutes: CLEANUP_INTERVAL_MINUTES
      }
    };
  } catch (err) {
    console.error('[Storage Cleanup] Error during cleanup sweep:', err.message);
    return {
      success: false,
      error: err.message,
      durationMs: Date.now() - startTime
    };
  } finally {
    isCleanupRunning = false;
  }
}

// 6. Production Schedulers
// Periodic background sweep every CLEANUP_INTERVAL_MINUTES
const cleanupTimer = setInterval(() => {
  runFullCleanup().catch(() => {});
}, CLEANUP_INTERVAL_MINUTES * 60 * 1000).unref();

// Run immediate startup sweep after 5 seconds to purge jobs that expired while offline
setTimeout(() => {
  runFullCleanup().catch(() => {});
}, 5000).unref();

/**
 * Lightweight test of R2 bucket connection without exposing credentials.
 */
async function testR2Connection() {
  if (!isR2Configured || !s3Client) {
    return {
      configured: false,
      connected: false,
      bucket: R2_BUCKET_NAME,
      endpoint: R2_ENDPOINT,
      message: isPlaceholderSecret
        ? 'R2_SECRET_ACCESS_KEY is not configured yet. Enter your secret in .env to connect.'
        : 'Cloudflare R2 is not fully configured.'
    };
  }

  try {
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET_NAME,
      MaxKeys: 1
    });
    await s3Client.send(cmd);
    return {
      configured: true,
      connected: true,
      bucket: R2_BUCKET_NAME,
      endpoint: R2_ENDPOINT,
      message: `Successfully connected to private Cloudflare R2 bucket "${R2_BUCKET_NAME}".`
    };
  } catch (err) {
    return {
      configured: true,
      connected: false,
      bucket: R2_BUCKET_NAME,
      endpoint: R2_ENDPOINT,
      message: `Failed to connect to Cloudflare R2 bucket "${R2_BUCKET_NAME}": ${err.message}`
    };
  }
}

module.exports = {
  isR2Configured,
  isD1Configured,
  R2_BUCKET_NAME,
  R2_ENDPOINT,
  OUTPUT_RETENTION_MINUTES,
  FAILED_JOB_RETENTION_MINUTES,
  CLEANUP_INTERVAL_MINUTES,
  ORPHAN_CLEANUP_HOURS,
  LOCAL_TEMP_RETENTION_MINUTES,
  CLEANUP_BATCH_SIZE,
  CLEANUP_ADMIN_SECRET,
  saveConvertedJob,
  recordFailedJob,
  getAuthorizedJob,
  getJobDownloadStream,
  deleteJob,
  cleanExpiredJobs,
  cleanOrphanedR2Objects,
  cleanStaleTempFiles,
  runFullCleanup,
  testR2Connection,
  sanitizeFilename,
  getMimeType,
  JOB_ID_REGEX,
  TOKEN_REGEX,
  _cleanupTimer: cleanupTimer
};
