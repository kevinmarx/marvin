-- Migration 009: Add last_phase column to worker-tracking tables
-- Tracks where each worker was when it last reported progress.
-- Used by ops phase to include phase info in timeout error messages
-- and by the dashboard to show current worker phase.

ALTER TABLE tickets ADD COLUMN last_phase TEXT;
ALTER TABLE audit_runs ADD COLUMN last_phase TEXT;
ALTER TABLE ci_fix_runs ADD COLUMN last_phase TEXT;
ALTER TABLE review_runs ADD COLUMN last_phase TEXT;
ALTER TABLE doc_runs ADD COLUMN last_phase TEXT;
