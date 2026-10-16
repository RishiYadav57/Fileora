-- Cloudflare D1 schema for Fileora job records (idempotent: safe to run more than once).
-- Matches the CREATE TABLE statements in storage.js (initD1IfNeeded), which also run them automatically when the
-- API token has D1 edit permission. Run it by hand in the D1 console or with:
--   npx wrangler d1 execute <database-name> --remote --file=migrations/001_create_conversion_jobs.sql
CREATE TABLE IF NOT EXISTS conversion_jobs (
  job_id             TEXT    PRIMARY KEY,                 -- cjob_<32 hex>
  download_token     TEXT    NOT NULL,                    -- 64 hex, secret, compared in constant time
  object_key         TEXT    NOT NULL,                    -- R2 key: converted/<job_id>/<file>; '' for failed-job records
  original_filename  TEXT    NOT NULL,
  converted_filename TEXT    NOT NULL,
  mime_type          TEXT    NOT NULL,
  file_size          INTEGER NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'completed',
  created_at         INTEGER NOT NULL,                    -- epoch milliseconds
  expires_at         INTEGER NOT NULL                     -- epoch milliseconds; created_at + 60 min by default
);
CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON conversion_jobs(expires_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON conversion_jobs(status);
