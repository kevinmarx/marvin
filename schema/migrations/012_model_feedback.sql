-- Model performance tracking for smart routing feedback loop

CREATE TABLE IF NOT EXISTS model_runs (
  id TEXT PRIMARY KEY,
  skill TEXT NOT NULL,
  phase TEXT,
  model TEXT NOT NULL,
  task_type TEXT NOT NULL,
  language TEXT,
  complexity INTEGER,
  ticket_id TEXT,
  ticket_identifier TEXT,

  -- Automatic signals
  success INTEGER NOT NULL DEFAULT 0,
  tests_passed INTEGER,
  test_retries INTEGER DEFAULT 0,
  ci_passed INTEGER,
  pr_review_rounds INTEGER DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,

  -- Human feedback
  human_rating INTEGER,
  human_notes TEXT,
  code_quality INTEGER,
  correctness INTEGER,
  efficiency INTEGER,
  test_quality INTEGER,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  rated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_runs_model ON model_runs(model);
CREATE INDEX IF NOT EXISTS idx_model_runs_task_type ON model_runs(task_type);
CREATE INDEX IF NOT EXISTS idx_model_runs_unrated ON model_runs(human_rating) WHERE human_rating IS NULL;

-- Routing weights learned from feedback
CREATE TABLE IF NOT EXISTS routing_weights (
  task_type TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 1.0,
  sample_count INTEGER DEFAULT 0,
  confidence REAL DEFAULT 0.0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (task_type, language, model)
);

-- Manual routing overrides (human says "force this model for this task type")
CREATE TABLE IF NOT EXISTS routing_overrides (
  task_type TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at TEXT,
  PRIMARY KEY (task_type, language)
);
