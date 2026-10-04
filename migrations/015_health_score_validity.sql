-- 015_health_score_validity.sql
-- ---------------------------------------------------------------------------
-- A health score is only meaningful if the audit that produced it actually read
-- the live profile. Two classes of run had neither:
--
--   * Runs up to 2 Oct 2026 scored PINNED TEST FIXTURES. Five fetch nodes in
--     GBP Main Audit carried pinned data, so every score to that point
--     described a location that does not exist (locations/1234567890123456789,
--     2 services, a 156-character description). Unpinned 4 Oct 2026.
--
--   * Execution 22044 read the live profile but the legacy Google My Business
--     API (mybusiness.googleapis.com) was never enabled in project
--     683796039477. Media and reviews returned 403 SERVICE_DISABLED, which the
--     scorer read as "zero photos, zero reviews" and scored 39.79/F against a
--     profile with 24 photos and 24 reviews at 4.7 stars. API enabled 4 Oct.
--
-- Nothing is deleted. Each superseded row keeps its score and records why it is
-- no longer counted, so the history of how this was found stays readable.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE gbp_health_scores
  ADD COLUMN IF NOT EXISTS is_valid boolean NOT NULL DEFAULT true;

ALTER TABLE gbp_health_scores
  ADD COLUMN IF NOT EXISTS invalid_reason text;

COMMENT ON COLUMN gbp_health_scores.is_valid IS
  'False when the audit could not read every input a scored dimension depends on '
  '(attributes, media, reviews). Written by GBP Main Audit from '
  'payload.score.is_valid; the health views and the previous_score lookup both '
  'filter on it.';

-- --------------------------------------------------------------- fixtures --
UPDATE gbp_health_scores hs
   SET is_valid = false,
       invalid_reason = 'scored pinned fixture data, not the live profile'
  FROM gbp_audit_runs ar
 WHERE ar.id = hs.run_id
   AND ar.n8n_execution_id IN ('11855', '11857', '11864', '21243');

-- ------------------------------------------------------- disabled v4 API --
UPDATE gbp_health_scores hs
   SET is_valid = false,
       invalid_reason = 'Google My Business API disabled; media and reviews '
                        'returned 403 SERVICE_DISABLED and both dimensions scored 0'
  FROM gbp_audit_runs ar
 WHERE ar.id = hs.run_id
   AND ar.n8n_execution_id = '22044';

-- ------------------------------------------------- superseded by a bugfix --
-- Execution 22050 read live data correctly, but the photos dimension looked for
-- a LOGO-category photo and Google returns the logo as PROFILE, so photo_logo
-- scored 0/10 against a profile that has one. Fixed in scoring/health-score.js;
-- 22050 is kept but not counted, so the 65.49 -> 67.49 step does not appear in
-- the trend as an improvement the business did not make.
UPDATE gbp_health_scores hs
   SET is_valid = false,
       invalid_reason = 'superseded by scoring fix: the logo check counted only '
                        'LOGO-category photos and Google returns the logo as '
                        'PROFILE, so photo_logo scored 0/10 incorrectly'
  FROM gbp_audit_runs ar
 WHERE ar.id = hs.run_id
   AND ar.n8n_execution_id = '22050';

-- A delta is only meaningful against a run that still counts. Execution 22062
-- is the first valid score, so it has no predecessor.
UPDATE gbp_health_scores hs
   SET previous_score = NULL,
       score_delta    = NULL
  FROM gbp_audit_runs ar
 WHERE ar.id = hs.run_id
   AND ar.n8n_execution_id = '22062';

-- -------------------------------------------------------------- the views --
-- Both are recreated with their original column list and order; the only change
-- is the is_valid predicate, so CREATE OR REPLACE is safe.

CREATE OR REPLACE VIEW v_gbp_latest_health AS
 SELECT DISTINCT ON (hs.location_id) hs.location_id,
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
    AND hs.is_valid
  ORDER BY hs.location_id, hs.scored_at DESC;

CREATE OR REPLACE VIEW v_gbp_score_trend AS
 SELECT hs.location_id,
    l.business_name,
    date(hs.scored_at) AS score_date,
    round(avg(hs.overall_score), 2) AS avg_overall,
    round(avg(hs.business_info_score), 2) AS avg_business_info,
    round(avg(hs.photos_score), 2) AS avg_photos,
    round(avg(hs.reviews_score), 2) AS avg_reviews,
    round(avg(hs.profile_score), 2) AS avg_profile,
    round(avg(hs.content_score), 2) AS avg_content,
    round(avg(hs.services_score), 2) AS avg_services
   FROM gbp_health_scores hs
     JOIN gbp_locations l ON l.id = hs.location_id
  WHERE hs.scored_at >= (CURRENT_DATE - '90 days'::interval)
    AND hs.is_valid
  GROUP BY hs.location_id, l.business_name, (date(hs.scored_at))
  ORDER BY hs.location_id, (date(hs.scored_at));

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
-- Expect exactly one valid row (execution 22062, 67.49, grade C) and six
-- superseded rows that each state a reason.
--
--   SELECT hs.id, ar.n8n_execution_id, hs.overall_score, hs.grade,
--          hs.is_valid, hs.invalid_reason
--     FROM gbp_health_scores hs
--     LEFT JOIN gbp_audit_runs ar ON ar.id = hs.run_id
--    ORDER BY hs.id;
--
--   SELECT * FROM v_gbp_score_trend;     -- one point: 2026-10-04, 67.49
--   SELECT * FROM v_gbp_latest_health;   -- 67.49 / C, no delta
