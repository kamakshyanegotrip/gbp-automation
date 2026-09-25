-- ============================================================================
-- MIGRATION 005: Create GBP Indexes and Reporting Views
-- Created: 2026-09-04
-- Purpose: Query performance plus the read models the dashboard and email
--          notification nodes consume
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Indexes
-- ----------------------------------------------------------------------------

-- Locations
CREATE INDEX IF NOT EXISTS idx_gbp_locations_active      ON gbp_locations(is_active) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gbp_locations_audit_due   ON gbp_locations(last_audited_at) WHERE audit_enabled;
CREATE INDEX IF NOT EXISTS idx_gbp_locations_google_name ON gbp_locations(google_location_name);

-- Audit runs
CREATE INDEX IF NOT EXISTS idx_gbp_runs_location   ON gbp_audit_runs(location_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_gbp_runs_status     ON gbp_audit_runs(status);
CREATE INDEX IF NOT EXISTS idx_gbp_runs_started_at ON gbp_audit_runs(started_at DESC);

-- Health scores
CREATE INDEX IF NOT EXISTS idx_gbp_scores_location ON gbp_health_scores(location_id, scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_gbp_scores_grade    ON gbp_health_scores(grade);
CREATE INDEX IF NOT EXISTS idx_gbp_scores_overall  ON gbp_health_scores(overall_score);

-- Dimension scores
CREATE INDEX IF NOT EXISTS idx_gbp_dim_scores_parent ON gbp_dimension_scores(health_score_id);
CREATE INDEX IF NOT EXISTS idx_gbp_dim_scores_key    ON gbp_dimension_scores(dimension_key, raw_score);

-- Recommendations
CREATE INDEX IF NOT EXISTS idx_gbp_reco_open
  ON gbp_recommendations(location_id, priority) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_gbp_reco_score  ON gbp_recommendations(health_score_id);
CREATE INDEX IF NOT EXISTS idx_gbp_reco_points ON gbp_recommendations(points_recoverable DESC);

-- Reviews
CREATE INDEX IF NOT EXISTS idx_gbp_reviews_location   ON gbp_reviews(location_id, review_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gbp_reviews_unanswered
  ON gbp_reviews(location_id, review_created_at) WHERE reply_status IN ('none', 'pending');
CREATE INDEX IF NOT EXISTS idx_gbp_reviews_rating     ON gbp_reviews(star_rating);
CREATE INDEX IF NOT EXISTS idx_gbp_reviews_escalation ON gbp_reviews(requires_escalation) WHERE requires_escalation;
CREATE INDEX IF NOT EXISTS idx_gbp_reviews_sentiment  ON gbp_reviews(sentiment);

-- Reply log
CREATE INDEX IF NOT EXISTS idx_gbp_reply_log_review ON gbp_review_reply_log(review_id, attempted_at DESC);

-- Review stats
CREATE INDEX IF NOT EXISTS idx_gbp_review_stats_location ON gbp_review_stats(location_id, captured_at DESC);

-- Posts
CREATE INDEX IF NOT EXISTS idx_gbp_posts_location  ON gbp_posts(location_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_gbp_posts_status    ON gbp_posts(status);
CREATE INDEX IF NOT EXISTS idx_gbp_posts_due
  ON gbp_posts(scheduled_for) WHERE status = 'scheduled';

-- Media
CREATE INDEX IF NOT EXISTS idx_gbp_media_location ON gbp_media(location_id, media_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gbp_media_category ON gbp_media(location_id, category) WHERE deleted_at IS NULL;

-- Services
CREATE INDEX IF NOT EXISTS idx_gbp_services_location ON gbp_services(location_id) WHERE deleted_at IS NULL;

-- Performance
CREATE INDEX IF NOT EXISTS idx_gbp_metrics_location_date ON gbp_performance_metrics(location_id, metric_date DESC);

-- ----------------------------------------------------------------------------
-- VIEW: latest health score per location
-- Used by the dashboard and the summary email.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_gbp_latest_health AS
SELECT DISTINCT ON (hs.location_id)
  hs.location_id,
  l.location_id AS location_key,
  l.business_name,
  l.city,
  hs.id AS health_score_id,
  hs.run_id,
  hs.overall_score,
  hs.grade,
  hs.business_info_score,
  hs.photos_score,
  hs.reviews_score,
  hs.profile_score,
  hs.content_score,
  hs.services_score,
  hs.previous_score,
  hs.score_delta,
  hs.ai_summary,
  hs.scored_at
FROM gbp_health_scores hs
JOIN gbp_locations l ON l.id = hs.location_id
WHERE l.deleted_at IS NULL
ORDER BY hs.location_id, hs.scored_at DESC;

COMMENT ON VIEW v_gbp_latest_health IS 'Most recent health score per active location';

-- ----------------------------------------------------------------------------
-- VIEW: open recommendations ranked by impact
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_gbp_open_recommendations AS
SELECT
  r.id,
  r.recommendation_id,
  r.location_id,
  l.business_name,
  r.dimension_key,
  d.display_name AS dimension_name,
  r.check_key,
  r.priority,
  r.title,
  r.detail,
  r.points_recoverable,
  r.created_at,
  CASE r.priority
    WHEN 'critical' THEN 1
    WHEN 'high'     THEN 2
    WHEN 'medium'   THEN 3
    ELSE 4
  END AS priority_rank
FROM gbp_recommendations r
JOIN gbp_locations l         ON l.id = r.location_id
JOIN gbp_score_dimensions d  ON d.dimension_key = r.dimension_key
WHERE r.status = 'open'
  AND l.deleted_at IS NULL
ORDER BY priority_rank, r.points_recoverable DESC NULLS LAST;

COMMENT ON VIEW v_gbp_open_recommendations IS 'Open fixes ranked by priority then recoverable score points';

-- ----------------------------------------------------------------------------
-- VIEW: reviews awaiting a reply
-- Drives the Review Response workflow queue and the SLA alert.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_gbp_pending_replies AS
SELECT
  rv.id,
  rv.location_id,
  l.business_name,
  l.auto_reply_enabled,
  rv.google_review_id,
  rv.reviewer_display_name,
  rv.star_rating,
  rv.comment,
  rv.sentiment,
  rv.requires_escalation,
  rv.ai_suggested_reply,
  rv.reply_status,
  rv.review_created_at,
  ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - rv.review_created_at)) / 3600.0, 2) AS hours_waiting
FROM gbp_reviews rv
JOIN gbp_locations l ON l.id = rv.location_id
WHERE rv.deleted_at IS NULL
  AND l.deleted_at IS NULL
  AND rv.reply_status IN ('none', 'pending', 'drafted', 'awaiting_approval')
ORDER BY rv.requires_escalation DESC, rv.review_created_at ASC;

COMMENT ON VIEW v_gbp_pending_replies IS 'Review reply queue, escalations first, then oldest';

-- ----------------------------------------------------------------------------
-- VIEW: 90-day score trend
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_gbp_score_trend AS
SELECT
  hs.location_id,
  l.business_name,
  DATE(hs.scored_at) AS score_date,
  ROUND(AVG(hs.overall_score), 2)       AS avg_overall,
  ROUND(AVG(hs.business_info_score), 2) AS avg_business_info,
  ROUND(AVG(hs.photos_score), 2)        AS avg_photos,
  ROUND(AVG(hs.reviews_score), 2)       AS avg_reviews,
  ROUND(AVG(hs.profile_score), 2)       AS avg_profile,
  ROUND(AVG(hs.content_score), 2)       AS avg_content,
  ROUND(AVG(hs.services_score), 2)      AS avg_services
FROM gbp_health_scores hs
JOIN gbp_locations l ON l.id = hs.location_id
WHERE hs.scored_at >= CURRENT_DATE - INTERVAL '90 days'
GROUP BY hs.location_id, l.business_name, DATE(hs.scored_at)
ORDER BY hs.location_id, score_date;

COMMENT ON VIEW v_gbp_score_trend IS 'Daily average scores over the last 90 days for charting';

COMMIT;

-- Verification query
-- SELECT * FROM v_gbp_latest_health;
-- SELECT * FROM v_gbp_open_recommendations LIMIT 20;
-- SELECT * FROM v_gbp_pending_replies LIMIT 20;
