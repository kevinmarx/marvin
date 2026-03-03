-- Migration 001: Initial schema
-- Combines state.sql, review.sql, ci_fix.sql, audit.sql into the baseline

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Core tables
CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    linear_id TEXT NOT NULL UNIQUE,
    identifier TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    priority INTEGER,
    status TEXT NOT NULL DEFAULT 'new',
    triage_result TEXT,
    complexity INTEGER,
    route TEXT,
    target_repo TEXT,
    affected_paths TEXT,
    pr_url TEXT,
    pr_number INTEGER,
    branch_name TEXT,
    worktree_path TEXT,
    error TEXT,
    assigned_to TEXT,
    assigned_to_name TEXT,
    digest_included_at TEXT,
    review_status TEXT DEFAULT NULL,
    defer_status TEXT,
    defer_comment_id TEXT,
    defer_followup_count INTEGER DEFAULT 0,
    defer_last_checked_at TEXT,
    defer_last_followup_at TEXT,
    defer_description_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    triaged_at TEXT,
    executed_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    finished_at TEXT,
    tickets_found INTEGER DEFAULT 0,
    tickets_triaged INTEGER DEFAULT 0,
    tickets_executed INTEGER DEFAULT 0,
    tickets_reassigned INTEGER DEFAULT 0,
    tickets_deferred INTEGER DEFAULT 0,
    tickets_failed INTEGER DEFAULT 0,
    errors TEXT
);

CREATE TABLE IF NOT EXISTS digests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    ticket_ids TEXT,
    content TEXT,
    linear_comment_id TEXT
);

CREATE TABLE IF NOT EXISTS pull_requests (
    pr_number        INTEGER NOT NULL,
    repo             TEXT NOT NULL,
    title            TEXT NOT NULL,
    url              TEXT NOT NULL,
    head_branch      TEXT NOT NULL,
    state            TEXT NOT NULL DEFAULT 'open',
    is_draft         INTEGER NOT NULL DEFAULT 0,
    ci_status        TEXT,
    review_decision  TEXT,
    unresolved_threads INTEGER DEFAULT 0,
    on_staging       INTEGER NOT NULL DEFAULT 0,
    ready_to_merge   INTEGER NOT NULL DEFAULT 0,
    ticket_linear_id TEXT,
    gh_created_at    TEXT,
    gh_updated_at    TEXT,
    ci_fix_status    TEXT,
    ci_fix_count     INTEGER DEFAULT 0,
    ci_fix_last_attempt_at TEXT,
    ci_fix_error     TEXT,
    author           TEXT,
    head_sha         TEXT,
    audit_status     TEXT,
    audit_risk       TEXT,
    audit_size       TEXT,
    audit_last_sha   TEXT,
    first_seen_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_polled_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    PRIMARY KEY (repo, pr_number)
);

CREATE TABLE IF NOT EXISTS review_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_linear_id TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    repo TEXT NOT NULL,
    comment_id INTEGER NOT NULL UNIQUE,
    thread_node_id TEXT,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    path TEXT,
    line INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    processed_at TEXT,
    response_body TEXT,
    commit_sha TEXT
);

CREATE TABLE IF NOT EXISTS review_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_linear_id TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    comments_addressed INTEGER DEFAULT 0,
    commits_pushed INTEGER DEFAULT 0,
    error TEXT
);

CREATE TABLE IF NOT EXISTS ci_fix_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_number INTEGER NOT NULL,
    repo TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    failure_type TEXT,
    files_changed INTEGER DEFAULT 0,
    commits_pushed INTEGER DEFAULT 0,
    error TEXT
);

CREATE TABLE IF NOT EXISTS audit_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_number INTEGER NOT NULL,
    repo TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    risk_level TEXT,
    size_label TEXT,
    findings_count INTEGER DEFAULT 0,
    approved INTEGER DEFAULT 0,
    error TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tickets_linear_id ON tickets(linear_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_identifier ON tickets(identifier);
CREATE INDEX IF NOT EXISTS idx_tickets_defer_status ON tickets(defer_status);
CREATE INDEX IF NOT EXISTS idx_pull_requests_state ON pull_requests(state);
CREATE INDEX IF NOT EXISTS idx_pull_requests_ready ON pull_requests(ready_to_merge);
CREATE INDEX IF NOT EXISTS idx_rc_status ON review_comments(status);
CREATE INDEX IF NOT EXISTS idx_rc_ticket ON review_comments(ticket_linear_id);
CREATE INDEX IF NOT EXISTS idx_rr_ticket ON review_runs(ticket_linear_id);
CREATE INDEX IF NOT EXISTS idx_cfr_pr ON ci_fix_runs(repo, pr_number);
CREATE INDEX IF NOT EXISTS idx_cfr_status ON ci_fix_runs(status);
CREATE INDEX IF NOT EXISTS idx_ar_pr ON audit_runs(repo, pr_number);
CREATE INDEX IF NOT EXISTS idx_ar_status ON audit_runs(status);
