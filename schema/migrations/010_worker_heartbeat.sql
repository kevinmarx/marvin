-- Migration 010: Add last_phase_at timestamp to worker-tracking tables
-- Workers update this every ~10 minutes alongside last_phase so the
-- dashboard and ops phase can detect truly stale workers vs workers
-- in a long-running phase.

ALTER TABLE tickets ADD COLUMN last_phase_at TEXT;
ALTER TABLE audit_runs ADD COLUMN last_phase_at TEXT;
ALTER TABLE ci_fix_runs ADD COLUMN last_phase_at TEXT;
ALTER TABLE review_runs ADD COLUMN last_phase_at TEXT;
ALTER TABLE doc_runs ADD COLUMN last_phase_at TEXT;
