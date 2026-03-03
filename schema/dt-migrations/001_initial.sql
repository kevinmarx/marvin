-- Deep Thought — Initial schema
-- All timestamps use strftime('%Y-%m-%dT%H:%M:%SZ', 'now') — never datetime('now')

CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,            -- 'alert', 'apm', 'logs', 'codebase_todo', 'codebase_deps', 'codebase_pattern'
    type TEXT NOT NULL,              -- 'monitor_alert', 'error_spike', 'latency_regression', 'log_pattern', 'todo', 'stale_dep', 'anti_pattern'
    dedup_hash TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    severity TEXT NOT NULL DEFAULT 'medium',  -- critical, high, medium, low
    confidence REAL NOT NULL DEFAULT 0.5,
    target_repo TEXT,
    affected_paths TEXT,             -- JSON array
    affected_service TEXT,
    status TEXT NOT NULL DEFAULT 'new',  -- new, ticket_created, resolved, deduped, skipped
    skip_reason TEXT,
    ticket_linear_id TEXT,
    ticket_identifier TEXT,          -- e.g. GM-1234
    ticket_url TEXT,
    datadog_monitor_id TEXT,
    datadog_context TEXT,            -- JSON blob with DD-specific metadata
    cooldown_until TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS scan_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_number INTEGER,
    phase TEXT,                      -- 'alerts', 'telemetry', 'codebase'
    alerts_checked INTEGER DEFAULT 0,
    traces_checked INTEGER DEFAULT 0,
    log_patterns_checked INTEGER DEFAULT 0,
    scanners_run INTEGER DEFAULT 0,
    findings_created INTEGER DEFAULT 0,
    tickets_created INTEGER DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cycle_number INTEGER NOT NULL DEFAULT 0,
    current_step TEXT,
    last_beat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    cycle_started_at TEXT,
    last_cycle_duration_seconds INTEGER
);

INSERT OR IGNORE INTO heartbeat (id) VALUES (1);

CREATE TABLE IF NOT EXISTS cycle_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_number INTEGER NOT NULL,
    step TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS scanner_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scanner_type TEXT NOT NULL,      -- 'todos', 'deps', 'patterns'
    repo TEXT NOT NULL,
    cycle_number INTEGER,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',  -- running, completed, failed
    findings_count INTEGER DEFAULT 0,
    results_file TEXT,               -- path to temp JSON results file
    error TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_findings_dedup ON findings(dedup_hash);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
CREATE INDEX IF NOT EXISTS idx_findings_source ON findings(source);
CREATE INDEX IF NOT EXISTS idx_findings_cooldown ON findings(cooldown_until);
CREATE INDEX IF NOT EXISTS idx_findings_ticket ON findings(ticket_linear_id);
CREATE INDEX IF NOT EXISTS idx_findings_created ON findings(created_at);
CREATE INDEX IF NOT EXISTS idx_ce_cycle ON cycle_events(cycle_number);
CREATE INDEX IF NOT EXISTS idx_ce_created ON cycle_events(created_at);
CREATE INDEX IF NOT EXISTS idx_sr_type ON scanner_runs(scanner_type);
CREATE INDEX IF NOT EXISTS idx_sr_status ON scanner_runs(status);
CREATE INDEX IF NOT EXISTS idx_scan_runs_cycle ON scan_runs(cycle_number);
