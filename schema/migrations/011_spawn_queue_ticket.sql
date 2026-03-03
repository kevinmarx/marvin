-- Migration 011: Add ticket_linear_id to spawn_queue
-- Allows the orchestrator to roll back ticket status when a spawn is cancelled
-- (e.g., due to concurrency limits). Without this, tickets get set to
-- 'executing'/'exploring' by the triage phase but never actually spawned,
-- creating zombie entries that eat concurrency slots.

ALTER TABLE spawn_queue ADD COLUMN ticket_linear_id TEXT;

CREATE INDEX IF NOT EXISTS idx_spawn_queue_ticket ON spawn_queue(ticket_linear_id);
