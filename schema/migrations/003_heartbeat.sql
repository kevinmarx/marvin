-- Migration 003: Add orchestrator heartbeat tracking
-- Enables the dashboard to show whether the orchestrator is alive, stuck, or dead

CREATE TABLE IF NOT EXISTS heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
    cycle_number INTEGER NOT NULL DEFAULT 0,
    current_step TEXT,
    last_beat_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    cycle_started_at TEXT,
    last_cycle_duration_seconds INTEGER
);

-- Seed the singleton row
INSERT OR IGNORE INTO heartbeat (id) VALUES (1);

-- Cycle event log for granular observability
CREATE TABLE IF NOT EXISTS cycle_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_number INTEGER NOT NULL,
    step TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ce_cycle ON cycle_events(cycle_number);
CREATE INDEX IF NOT EXISTS idx_ce_created ON cycle_events(created_at);
