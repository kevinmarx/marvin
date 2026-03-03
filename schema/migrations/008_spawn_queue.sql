-- Spawn queue: phases write spawn requests, orchestrator drains and spawns workers
-- This decouples worker spawning from phase agents (which are short-lived Task agents
-- whose background children get killed on exit) and moves it to the orchestrator
-- (which is long-lived and whose background Task agents survive).

CREATE TABLE IF NOT EXISTS spawn_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_type TEXT NOT NULL,       -- executor, explorer, ci_fix, auditor, reviewer, docs
    worker_name TEXT NOT NULL,       -- e.g. exec-6200, ci-fix-my-repo-4521
    prompt TEXT NOT NULL,            -- full prompt for the Task agent
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, spawned, failed
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    spawned_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_spawn_queue_status ON spawn_queue(status);
