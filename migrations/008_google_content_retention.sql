-- ============================================================================
-- MIGRATION 008: 30-day retention for content received from Google
-- Created: 2026-09-05
-- Purpose: The Google Business Profile API policies allow content received from
--          Google to be cached only "temporarily, for no more than 30 calendar
--          days". The published privacy policy at
--          automation.assignover.in/privacy states the same. Nothing enforced
--          it, so review text, reviewer names, photo URLs, service copy,
--          performance metrics and the full raw API snapshots were being kept
--          indefinitely.
--
-- Approach: REDACT, don't delete. After the retention window we strip the
--          Google-sourced content out of a row but keep the numeric skeleton we
--          derived ourselves — star rating, reply status, response latency,
--          photo counts and categories. That keeps the reply-rate and photo
--          history that the health score trend depends on, while removing every
--          piece of personal data and every piece of Google's content.
--
--          Rows are only touched once they have gone `retention_days` without
--          being refreshed, so an actively synced profile is never redacted.
--
-- What is NOT purged, and why:
--   gbp_health_scores, gbp_dimension_scores, gbp_recommendations — our own
--     assessments, not Google content.
--   gbp_posts, gbp_review_reply_log.reply_text — copy we authored.
--   gbp_review_stats — aggregate counts we computed.
--   gbp_locations — the client's own business details, supplied by the client.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Mark rows so a redaction is visible and never repeated
-- ----------------------------------------------------------------------------
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS redacted_at TIMESTAMP;
ALTER TABLE gbp_media   ADD COLUMN IF NOT EXISTS redacted_at TIMESTAMP;
ALTER TABLE gbp_services ADD COLUMN IF NOT EXISTS redacted_at TIMESTAMP;

COMMENT ON COLUMN gbp_reviews.redacted_at IS
  'When Google-sourced content was stripped from this row under the 30-day retention rule';
COMMENT ON COLUMN gbp_media.redacted_at IS
  'When Google-sourced URLs were stripped from this row under the 30-day retention rule';
COMMENT ON COLUMN gbp_services.redacted_at IS
  'When Google-sourced service copy was stripped from this row under the 30-day retention rule';

-- ----------------------------------------------------------------------------
-- Audit trail — proof the purge actually runs
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_retention_runs (
  id SERIAL PRIMARY KEY,
  ran_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  retention_days    INT NOT NULL,
  reviews_redacted  INT NOT NULL DEFAULT 0,
  media_redacted    INT NOT NULL DEFAULT 0,
  services_redacted INT NOT NULL DEFAULT 0,
  snapshots_cleared INT NOT NULL DEFAULT 0,
  metrics_deleted   INT NOT NULL DEFAULT 0,
  n8n_execution_id  VARCHAR(50)
);

COMMENT ON TABLE gbp_retention_runs IS
  'One row per retention sweep; evidence that the 30-day Google content rule is enforced';

CREATE INDEX IF NOT EXISTS idx_gbp_retention_runs_ran_at
  ON gbp_retention_runs (ran_at DESC);

-- Partial indexes so each sweep only scans candidate rows
CREATE INDEX IF NOT EXISTS idx_gbp_reviews_retention
  ON gbp_reviews (last_synced_at) WHERE redacted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gbp_media_retention
  ON gbp_media (last_synced_at) WHERE redacted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gbp_services_retention
  ON gbp_services (last_synced_at) WHERE redacted_at IS NULL;

-- ----------------------------------------------------------------------------
-- The sweep itself
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gbp_purge_expired_google_content(
  retention_days INT DEFAULT 30,
  execution_id   TEXT DEFAULT NULL
)
RETURNS TABLE (
  reviews_redacted  INT,
  media_redacted    INT,
  services_redacted INT,
  snapshots_cleared INT,
  metrics_deleted   INT
)
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff TIMESTAMP := now() - make_interval(days => retention_days);
  v_reviews INT; v_media INT; v_services INT; v_snapshots INT; v_metrics INT;
BEGIN
  -- Reviews: strip reviewer identity and every piece of text. The AI draft and
  -- the escalation reason are stripped too, because both quote the review.
  WITH upd AS (
    UPDATE gbp_reviews SET
      reviewer_display_name = NULL,
      comment               = NULL,
      comment_language      = NULL,
      reply_comment         = NULL,
      ai_suggested_reply    = NULL,
      escalation_reason     = NULL,
      hold_reasons          = NULL,
      redacted_at           = now(),
      updated_at            = now()
    WHERE redacted_at IS NULL
      AND last_synced_at < cutoff
    RETURNING 1
  ) SELECT count(*)::INT INTO v_reviews FROM upd;

  -- Media: the Google-hosted URLs are the content. Counts, categories and
  -- dimensions stay so the photos dimension keeps its history.
  WITH upd AS (
    UPDATE gbp_media SET
      google_url    = NULL,
      thumbnail_url = NULL,
      redacted_at   = now()
    WHERE redacted_at IS NULL
      AND last_synced_at < cutoff
    RETURNING 1
  ) SELECT count(*)::INT INTO v_media FROM upd;

  -- Services: display name and description are the profile's copy.
  WITH upd AS (
    UPDATE gbp_services SET
      display_name = '(redacted)',
      description  = NULL,
      category     = NULL,
      redacted_at  = now()
    WHERE redacted_at IS NULL
      AND last_synced_at < cutoff
    RETURNING 1
  ) SELECT count(*)::INT INTO v_services FROM upd;

  -- Raw snapshots hold the complete API payload — the single largest store of
  -- Google content in the database.
  WITH upd AS (
    UPDATE gbp_audit_runs SET raw_snapshot = NULL
    WHERE raw_snapshot IS NOT NULL
      AND COALESCE(finished_at, started_at, created_at) < cutoff
    RETURNING 1
  ) SELECT count(*)::INT INTO v_snapshots FROM upd;

  -- Performance metrics are deleted outright; the privacy policy places them in
  -- the 30-day bucket, and gbp_health_scores preserves the trend we report on.
  WITH del AS (
    DELETE FROM gbp_performance_metrics
    WHERE captured_at < cutoff
    RETURNING 1
  ) SELECT count(*)::INT INTO v_metrics FROM del;

  INSERT INTO gbp_retention_runs (
    retention_days, reviews_redacted, media_redacted,
    services_redacted, snapshots_cleared, metrics_deleted, n8n_execution_id
  ) VALUES (
    retention_days, v_reviews, v_media, v_services, v_snapshots, v_metrics, execution_id
  );

  RETURN QUERY SELECT v_reviews, v_media, v_services, v_snapshots, v_metrics;
END;
$$;

COMMENT ON FUNCTION gbp_purge_expired_google_content(INT, TEXT) IS
  'Enforces the 30-day limit on cached Google content. Redacts stale rows, clears raw snapshots, deletes expired metrics, and logs the sweep to gbp_retention_runs.';

COMMIT;

-- Verify:
--   SELECT * FROM gbp_purge_expired_google_content(30, 'manual');
--   SELECT * FROM gbp_retention_runs ORDER BY id DESC LIMIT 5;
--
-- Dry run against a shorter window to prove it selects the right rows:
--   SELECT count(*) FROM gbp_reviews
--    WHERE redacted_at IS NULL AND last_synced_at < now() - interval '30 days';
