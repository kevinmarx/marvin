-- Migration 002: Add last_phase tracking to scanner_runs
-- Mirrors Marvin's migration 009/010 — allows the ops phase to see
-- where a scanner was when it stalled, and lets the dashboard show
-- real-time scanner progress.

ALTER TABLE scanner_runs ADD COLUMN last_phase TEXT;
ALTER TABLE scanner_runs ADD COLUMN last_phase_at TEXT;
