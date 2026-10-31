CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, content TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL UNIQUE, body_hash TEXT NOT NULL,
 payload TEXT, state TEXT NOT NULL, created INTEGER NOT NULL, runner_id TEXT,
 answer TEXT, reply_status INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created);
