-- Migration 007: Add merge conflict detection and auto-rebase tracking
ALTER TABLE pull_requests ADD COLUMN mergeable TEXT;
ALTER TABLE pull_requests ADD COLUMN merge_state TEXT;
ALTER TABLE pull_requests ADD COLUMN behind_by INTEGER DEFAULT 0;
ALTER TABLE pull_requests ADD COLUMN rebase_status TEXT;
ALTER TABLE pull_requests ADD COLUMN rebase_count INTEGER DEFAULT 0;
ALTER TABLE pull_requests ADD COLUMN rebase_last_attempt_at TEXT;
ALTER TABLE pull_requests ADD COLUMN rebase_error TEXT;
CREATE INDEX IF NOT EXISTS idx_pr_rebase ON pull_requests(rebase_status);
