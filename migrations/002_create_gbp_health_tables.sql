-- ============================================================================
-- MIGRATION 002: Create GBP Health Scoring Tables
-- Created: 2026-09-04
-- Purpose: Weighted health scores, per-dimension breakdown, and the
--          actionable recommendations generated from each audit run
--
-- Scoring model (weights must total 100):
--   business_info  25%   profile completeness, accurate address/hours
--   photos         20%   count, recency, coverage
--   reviews        20%   count, rating, response rate
--   profile        15%   attribute + verification completeness
--   content        10%   post recency and quantity
--   services       10%   service count and description quality
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Dimension registry
-- Weights live in the database so they can be retuned without a code deploy.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_score_dimensions (
  id SERIAL PRIMARY KEY,
  dimension_key  VARCHAR(30) UNIQUE NOT NULL,
  display_name   VARCHAR(100) NOT NULL,
  weight_percent NUMERIC(5, 2) NOT NULL,
  description    TEXT,
  sort_order     INT DEFAULT 0,
  is_active      BOOLEAN DEFAULT true,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT gbp_dimension_weight_range CHECK (weight_percent >= 0 AND weight_percent <= 100)
);

COMMENT ON TABLE gbp_score_dimensions IS 'Weighted dimensions of the GBP health score; weights should sum to 100';

INSERT INTO gbp_score_dimensions (dimension_key, display_name, weight_percent, description, sort_order)
VALUES
  ('business_info', 'Business Information', 25.00, 'Name, categories, address, phone, website, hours, description', 1),
  ('photos',        'Photos',              20.00, 'Photo count, recency, and coverage across required types',      2),
  ('reviews',       'Reviews',             20.00, 'Review volume, average rating, reply rate and reply speed',     3),
  ('profile',       'Profile Completeness',15.00, 'Attributes, verification state, place actions, Q&A',            4),
  ('content',       'Content',             10.00, 'Local post recency, frequency and variety',                     5),
  ('services',      'Services',            10.00, 'Service item count, descriptions and pricing',                  6)
ON CONFLICT (dimension_key) DO UPDATE
  SET weight_percent = EXCLUDED.weight_percent,
      display_name   = EXCLUDED.display_name,
      description    = EXCLUDED.description,
      sort_order     = EXCLUDED.sort_order,
      updated_at     = CURRENT_TIMESTAMP;

-- ----------------------------------------------------------------------------
-- Health scores — one row per audit run
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_health_scores (
  id SERIAL PRIMARY KEY,

  run_id      INT NOT NULL REFERENCES gbp_audit_runs(id) ON DELETE CASCADE,
  location_id INT NOT NULL REFERENCES gbp_locations(id)  ON DELETE CASCADE,

  -- Overall (0.00 - 100.00)
  overall_score NUMERIC(5, 2) NOT NULL,
  grade         CHAR(1) NOT NULL,

  -- Weighted contribution of each dimension, denormalised for fast charting
  business_info_score NUMERIC(5, 2),
  photos_score        NUMERIC(5, 2),
  reviews_score       NUMERIC(5, 2),
  profile_score       NUMERIC(5, 2),
  content_score       NUMERIC(5, 2),
  services_score      NUMERIC(5, 2),

  -- Movement since the previous scored run for this location
  previous_score NUMERIC(5, 2),
  score_delta    NUMERIC(6, 2),

  -- Narrative summary produced by the Claude API node
  ai_summary TEXT,

  scored_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT gbp_health_score_range CHECK (overall_score >= 0 AND overall_score <= 100),
  CONSTRAINT gbp_health_grade_valid CHECK (grade IN ('A', 'B', 'C', 'D', 'F')),
  CONSTRAINT gbp_health_one_per_run  UNIQUE (run_id)
);

COMMENT ON TABLE  gbp_health_scores IS 'Overall weighted health score per audit run';
COMMENT ON COLUMN gbp_health_scores.business_info_score IS 'Raw 0-100 subscore, BEFORE the 25% weight is applied';
COMMENT ON COLUMN gbp_health_scores.grade IS 'A >=85, B >=70, C >=55, D >=40, F <40';

-- ----------------------------------------------------------------------------
-- Per-dimension detail, including the individual checks that produced it
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_dimension_scores (
  id SERIAL PRIMARY KEY,

  health_score_id INT NOT NULL REFERENCES gbp_health_scores(id) ON DELETE CASCADE,
  dimension_key   VARCHAR(30) NOT NULL REFERENCES gbp_score_dimensions(dimension_key),

  raw_score      NUMERIC(5, 2) NOT NULL,
  weight_percent NUMERIC(5, 2) NOT NULL,
  weighted_score NUMERIC(5, 2) NOT NULL,

  -- Array of {key, label, points, max_points, passed, detail}
  checks JSONB,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT gbp_dimension_raw_range CHECK (raw_score >= 0 AND raw_score <= 100),
  CONSTRAINT gbp_dimension_once_per_score UNIQUE (health_score_id, dimension_key)
);

COMMENT ON TABLE  gbp_dimension_scores IS 'Per-dimension breakdown with the individual checks behind each score';
COMMENT ON COLUMN gbp_dimension_scores.checks IS 'JSON array of individual checks: key, label, points, max_points, passed, detail';

-- ----------------------------------------------------------------------------
-- Recommendations — the actionable output of an audit
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_recommendations (
  id SERIAL PRIMARY KEY,
  recommendation_id VARCHAR(50) UNIQUE NOT NULL,

  health_score_id INT NOT NULL REFERENCES gbp_health_scores(id) ON DELETE CASCADE,
  location_id     INT NOT NULL REFERENCES gbp_locations(id)     ON DELETE CASCADE,

  dimension_key VARCHAR(30) NOT NULL REFERENCES gbp_score_dimensions(dimension_key),
  check_key     VARCHAR(60),

  priority VARCHAR(10) NOT NULL,
  title    VARCHAR(255) NOT NULL,
  detail   TEXT,

  -- How many points of the overall score this would recover if fixed
  points_recoverable NUMERIC(5, 2),

  -- Workflow state
  status       VARCHAR(20) DEFAULT 'open',
  resolved_at  TIMESTAMP,
  resolved_note TEXT,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT gbp_reco_priority_valid CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  CONSTRAINT gbp_reco_status_valid   CHECK (status IN ('open', 'in_progress', 'resolved', 'dismissed'))
);

COMMENT ON TABLE  gbp_recommendations IS 'Actionable fixes derived from failed checks, ranked by recoverable points';
COMMENT ON COLUMN gbp_recommendations.points_recoverable IS 'Overall-score points regained if this single check passes';

DROP TRIGGER IF EXISTS trg_gbp_recommendations_touch ON gbp_recommendations;
CREATE TRIGGER trg_gbp_recommendations_touch
  BEFORE UPDATE ON gbp_recommendations
  FOR EACH ROW EXECUTE FUNCTION gbp_touch_updated_at();

COMMIT;

-- Verification query
-- SELECT dimension_key, weight_percent FROM gbp_score_dimensions ORDER BY sort_order;
-- SELECT SUM(weight_percent) AS should_be_100 FROM gbp_score_dimensions WHERE is_active;
