-- Migration 006: Add missing indexes for foreign key lookups
CREATE INDEX IF NOT EXISTS idx_pr_ticket ON pull_requests(ticket_linear_id);
CREATE INDEX IF NOT EXISTS idx_rc_pr ON review_comments(pr_number);
