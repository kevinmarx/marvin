-- Migration 004: Add reassess request queue
-- Dashboard writes requests, orchestrator reads and processes them

CREATE TABLE IF NOT EXISTS reassess_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    linear_id TEXT NOT NULL,
    identifier TEXT NOT NULL,
    requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_rr_pending ON reassess_requests(processed_at);
