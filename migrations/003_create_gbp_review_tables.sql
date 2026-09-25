-- ============================================================================
-- MIGRATION 003: Create GBP Review Tables
-- Created: 2026-09-04
-- Purpose: Review mirror and reply tracking for the GBP Review Response
--          workflow
--
-- API NOTE: reviews are served ONLY by the legacy Google My Business API v4
--   GET  https://mybusiness.googleapis.com/v4/{parent}/reviews
--   PUT  https://mybusiness.googleapis.com/v4/{name}/reply
-- v4 requires the project to be allowlisted. Until "Requests per minute"
-- leaves 0, these calls return 403 and the audit run is marked 'partial'.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Reviews mirrored from the API
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_reviews (
  id SERIAL PRIMARY KEY,

  location_id INT NOT NULL REFERENCES gbp_locations(id) ON DELETE CASCADE,

  -- Google's review resource name is the natural key
  google_review_id VARCHAR(255) UNIQUE NOT NULL,

  -- Reviewer (store display name only; do not persist profile photo URLs)
  reviewer_display_name VARCHAR(255),
  is_anonymous          BOOLEAN DEFAULT false,

  -- Content
  star_rating   SMALLINT NOT NULL,
  comment       TEXT,
  comment_language VARCHAR(10),

  -- Timing as reported by Google
  review_created_at TIMESTAMP,
  review_updated_at TIMESTAMP,

  -- Reply state
  reply_comment      TEXT,
  reply_updated_at   TIMESTAMP,
  reply_source       VARCHAR(20),
  reply_status       VARCHAR(20) DEFAULT 'none',
  reply_attempts     INT DEFAULT 0,
  reply_error        TEXT,

  -- Response latency in hours, computed when a reply lands
  response_latency_hours NUMERIC(10, 2),

  -- Triage produced by the Claude API node
  sentiment       VARCHAR(20),
  sentiment_score NUMERIC(4, 3),
  requires_escalation BOOLEAN DEFAULT false,
  escalation_reason   TEXT,
  ai_suggested_reply  TEXT,

  -- Bookkeeping
  first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP,

  CONSTRAINT gbp_review_rating_range CHECK (star_rating BETWEEN 1 AND 5),
  CONSTRAINT gbp_review_reply_status_valid
    CHECK (reply_status IN ('none', 'pending', 'drafted', 'awaiting_approval', 'sent', 'failed', 'skipped')),
  CONSTRAINT gbp_review_reply_source_valid
    CHECK (reply_source IS NULL OR reply_source IN ('automation', 'human', 'imported')),
  CONSTRAINT gbp_review_sentiment_valid
    CHECK (sentiment IS NULL OR sentiment IN ('positive', 'neutral', 'negative', 'mixed'))
);

COMMENT ON TABLE  gbp_reviews IS 'Mirror of Google reviews plus reply state and AI triage';
COMMENT ON COLUMN gbp_reviews.google_review_id IS 'Google review resource name; the idempotency key for syncing';
COMMENT ON COLUMN gbp_reviews.reply_status IS 'awaiting_approval is used when auto_reply_enabled is false on the location';
COMMENT ON COLUMN gbp_reviews.response_latency_hours IS 'Hours between review_created_at and reply_updated_at';

-- ----------------------------------------------------------------------------
-- Reply audit log — every attempt, including failures and edits
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_review_reply_log (
  id SERIAL PRIMARY KEY,

  review_id INT NOT NULL REFERENCES gbp_reviews(id) ON DELETE CASCADE,

  attempt_number INT NOT NULL DEFAULT 1,
  reply_text     TEXT NOT NULL,
  generated_by   VARCHAR(20) NOT NULL DEFAULT 'automation',

  -- Result
  outcome          VARCHAR(20) NOT NULL,
  http_status      INT,
  api_error        TEXT,

  -- Claude accounting
  model_used    VARCHAR(100),
  input_tokens  INT,
  output_tokens INT,

  n8n_execution_id VARCHAR(100),
  attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT gbp_reply_log_outcome_valid
    CHECK (outcome IN ('sent', 'failed', 'drafted', 'rejected', 'superseded')),
  CONSTRAINT gbp_reply_log_generated_by_valid
    CHECK (generated_by IN ('automation', 'human'))
);

COMMENT ON TABLE gbp_review_reply_log IS 'Append-only log of every reply attempt for traceability';

-- ----------------------------------------------------------------------------
-- Rolling review statistics per location, refreshed by the audit workflow
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_review_stats (
  id SERIAL PRIMARY KEY,

  location_id INT NOT NULL REFERENCES gbp_locations(id) ON DELETE CASCADE,
  run_id      INT REFERENCES gbp_audit_runs(id) ON DELETE SET NULL,

  total_reviews    INT DEFAULT 0,
  average_rating   NUMERIC(3, 2),

  count_5_star INT DEFAULT 0,
  count_4_star INT DEFAULT 0,
  count_3_star INT DEFAULT 0,
  count_2_star INT DEFAULT 0,
  count_1_star INT DEFAULT 0,

  reviews_with_reply INT DEFAULT 0,
  response_rate      NUMERIC(5, 2),
  median_response_hours NUMERIC(10, 2),

  reviews_last_30_days INT DEFAULT 0,
  unanswered_count     INT DEFAULT 0,
  oldest_unanswered_at TIMESTAMP,

  captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT gbp_review_stats_rate_range
    CHECK (response_rate IS NULL OR (response_rate >= 0 AND response_rate <= 100))
);

COMMENT ON TABLE gbp_review_stats IS 'Point-in-time review aggregates feeding the Reviews dimension (20%)';

DROP TRIGGER IF EXISTS trg_gbp_reviews_touch ON gbp_reviews;
CREATE TRIGGER trg_gbp_reviews_touch
  BEFORE UPDATE ON gbp_reviews
  FOR EACH ROW EXECUTE FUNCTION gbp_touch_updated_at();

COMMIT;

-- Verification query
-- SELECT * FROM gbp_reviews LIMIT 0;
-- SELECT * FROM gbp_review_stats LIMIT 0;
