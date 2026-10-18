-- Download-page feedback (reviews). Run once against the D1 database before enabling feedback in production:
--   wrangler d1 execute <DATABASE_NAME> --remote --file=migrations/002_create_feedback.sql
-- Contains no file names, file contents, e-mail addresses or IP addresses.
CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  category    TEXT NOT NULL,
  name        TEXT,
  country     TEXT,
  comment     TEXT,
  tool        TEXT,
  job_id      TEXT,
  emailed     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_job ON feedback(job_id) WHERE job_id IS NOT NULL;
