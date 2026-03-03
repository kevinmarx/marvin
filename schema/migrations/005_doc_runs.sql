-- Migration 005: Add documentation run tracking
-- Tracks follow-up documentation PRs created from executor knowledge

CREATE TABLE IF NOT EXISTS doc_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_identifier TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER,
    pr_url TEXT,
    knowledge_path TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',  -- running, completed, failed, skipped
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_dr_ticket ON doc_runs(ticket_identifier);
CREATE INDEX IF NOT EXISTS idx_dr_status ON doc_runs(status);
