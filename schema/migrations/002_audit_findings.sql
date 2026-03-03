-- Migration 002: Add audit findings detail storage
-- Stores the actual findings from each audit run, not just the count

ALTER TABLE audit_runs ADD COLUMN findings_json TEXT;
-- JSON array of findings, each: {category, path, line, issue, suggestion}
