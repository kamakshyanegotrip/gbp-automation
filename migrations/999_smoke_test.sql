-- ============================================================================
-- SMOKE TEST (not a migration — safe to run against a scratch database only)
-- Created: 2026-09-04
-- Purpose: Prove the schema accepts a full audit cycle and the views return
--          sensible rows. Wrapped in a transaction that ROLLS BACK, so it
--          leaves no data behind.
-- Run: psql -d your_db -v ON_ERROR_STOP=1 -f migrations/999_smoke_test.sql
-- ============================================================================

BEGIN;

-- 1. Register a location -----------------------------------------------------
INSERT INTO gbp_locations (
  location_id, google_account_name, google_location_name,
  business_name, primary_category, website_url, phone,
  city, state, country, verification_state, notify_emails
) VALUES (
  'gbp_loc_001', 'accounts/106000000000000000000', 'locations/1234567890123456789',
  'Negotrip', 'Travel agency', 'https://negotrip.in', '+91 90000 00000',
  'Bhubaneswar', 'Odisha', 'IN', 'verified', 'kn0733@gmail.com'
);

-- 2. Record an audit run -----------------------------------------------------
INSERT INTO gbp_audit_runs (
  run_id, location_id, trigger_type, n8n_workflow_name,
  status, finished_at, duration_ms, api_calls_made, raw_snapshot
) VALUES (
  'run_20260904_0001',
  (SELECT id FROM gbp_locations WHERE location_id = 'gbp_loc_001'),
  'scheduled', 'GBP Main Audit',
  'completed', CURRENT_TIMESTAMP, 8420, 11,
  '{"title":"Negotrip","websiteUri":"https://negotrip.in"}'::jsonb
);

-- 3. Store the health score --------------------------------------------------
INSERT INTO gbp_health_scores (
  run_id, location_id, overall_score, grade,
  business_info_score, photos_score, reviews_score,
  profile_score, content_score, services_score,
  previous_score, score_delta, ai_summary
) VALUES (
  (SELECT id FROM gbp_audit_runs WHERE run_id = 'run_20260904_0001'),
  (SELECT id FROM gbp_locations  WHERE location_id = 'gbp_loc_001'),
  52.42, 'D',
  74.09, 37.00, 61.02, 54.00, 15.99, 46.00,
  51.40, 1.02,
  'Profile is held back by thin photo coverage and no posts in the last 30 days.'
);

-- 4. Dimension breakdown -----------------------------------------------------
INSERT INTO gbp_dimension_scores (health_score_id, dimension_key, raw_score, weight_percent, weighted_score, checks)
SELECT
  (SELECT id FROM gbp_health_scores WHERE run_id = (SELECT id FROM gbp_audit_runs WHERE run_id = 'run_20260904_0001')),
  d.dimension_key, v.raw, d.weight_percent, ROUND(v.raw * d.weight_percent / 100, 2),
  '[{"key":"example","label":"Example check","points":0,"max_points":10,"passed":false,"detail":"demo"}]'::jsonb
FROM gbp_score_dimensions d
JOIN (VALUES
  ('business_info', 74.09), ('photos', 37.00), ('reviews', 61.02),
  ('profile', 54.00), ('content', 15.99), ('services', 46.00)
) AS v(key, raw) ON v.key = d.dimension_key;

-- 5. Recommendations ---------------------------------------------------------
INSERT INTO gbp_recommendations (
  recommendation_id, health_score_id, location_id, dimension_key, check_key,
  priority, title, detail, points_recoverable
) VALUES
  ('reco_0001',
   (SELECT id FROM gbp_health_scores WHERE overall_score = 52.42),
   (SELECT id FROM gbp_locations WHERE location_id = 'gbp_loc_001'),
   'photos', 'photo_count', 'high', 'At least 20 owner photos', '6 photos', 4.20),
  ('reco_0002',
   (SELECT id FROM gbp_health_scores WHERE overall_score = 52.42),
   (SELECT id FROM gbp_locations WHERE location_id = 'gbp_loc_001'),
   'content', 'post_frequency', 'high', 'At least 4 posts in the last 30 days', '0 posts in 30 days', 4.00),
  ('reco_0003',
   (SELECT id FROM gbp_health_scores WHERE overall_score = 52.42),
   (SELECT id FROM gbp_locations WHERE location_id = 'gbp_loc_001'),
   'reviews', 'response_rate', 'high', 'Reply to every review', '45% answered', 3.85);

-- 6. A review needing a reply ------------------------------------------------
INSERT INTO gbp_reviews (
  location_id, google_review_id, reviewer_display_name, star_rating, comment,
  review_created_at, reply_status, sentiment, requires_escalation, ai_suggested_reply
) VALUES (
  (SELECT id FROM gbp_locations WHERE location_id = 'gbp_loc_001'),
  'accounts/106/locations/123/reviews/AbC123',
  'A. Traveller', 2, 'Pickup was late and nobody answered the phone.',
  CURRENT_TIMESTAMP - INTERVAL '30 hours',
  'drafted', 'negative', true,
  'We are sorry about the delay and want to make this right.'
);

INSERT INTO gbp_review_reply_log (review_id, reply_text, outcome, model_used, input_tokens, output_tokens)
VALUES (
  (SELECT id FROM gbp_reviews WHERE google_review_id = 'accounts/106/locations/123/reviews/AbC123'),
  'We are sorry about the delay and want to make this right.',
  'drafted', 'claude-opus-4', 812, 96
);

-- 7. Review aggregates -------------------------------------------------------
INSERT INTO gbp_review_stats (
  location_id, run_id, total_reviews, average_rating,
  count_5_star, count_4_star, count_3_star, count_2_star, count_1_star,
  reviews_with_reply, response_rate, median_response_hours,
  reviews_last_30_days, unanswered_count
) VALUES (
  (SELECT id FROM gbp_locations  WHERE location_id = 'gbp_loc_001'),
  (SELECT id FROM gbp_audit_runs WHERE run_id = 'run_20260904_0001'),
  28, 4.30, 15, 6, 3, 3, 1, 13, 45.00, 96.00, 4, 15
);

-- 8. Content, media, services, metrics ---------------------------------------
INSERT INTO gbp_posts (post_id, location_id, topic_type, summary, cta_type, cta_url, status, published_at)
VALUES ('post_0001',
  (SELECT id FROM gbp_locations WHERE location_id = 'gbp_loc_001'),
  'OFFER', 'Monsoon package to Puri, 15% off until the end of the month.',
  'BOOK', 'https://negotrip.in/puri', 'published', CURRENT_TIMESTAMP - INTERVAL '45 days');

INSERT INTO gbp_media (location_id, google_media_name, media_format, category, media_created_at)
VALUES (
  (SELECT id FROM gbp_locations WHERE location_id = 'gbp_loc_001'),
  'accounts/106/locations/123/media/xyz', 'PHOTO', 'EXTERIOR',
  CURRENT_TIMESTAMP - INTERVAL '150 days');

INSERT INTO gbp_services (location_id, service_key, display_name, description, price_amount_micros, price_currency)
VALUES (
  (SELECT id FROM gbp_locations WHERE location_id = 'gbp_loc_001'),
  'airport_transfer', 'Airport transfer', 'Private cab between Biju Patnaik airport and any city hotel.',
  250000000, 'INR');

INSERT INTO gbp_performance_metrics (
  location_id, metric_date,
  business_impressions_mobile_search, business_impressions_desktop_search,
  call_clicks, website_clicks, business_direction_requests
) VALUES (
  (SELECT id FROM gbp_locations WHERE location_id = 'gbp_loc_001'),
  CURRENT_DATE - 1, 412, 88, 17, 34, 21);

-- 9. Read the views back -----------------------------------------------------
\echo '--- v_gbp_latest_health'
SELECT business_name, overall_score, grade, score_delta FROM v_gbp_latest_health;

\echo '--- v_gbp_open_recommendations'
SELECT priority, title, points_recoverable FROM v_gbp_open_recommendations;

\echo '--- v_gbp_pending_replies'
SELECT star_rating, requires_escalation, ROUND(hours_waiting) AS hours_waiting FROM v_gbp_pending_replies;

\echo '--- weights sanity'
SELECT SUM(weight_percent) AS should_be_100 FROM gbp_score_dimensions WHERE is_active;

\echo '--- weighted sum equals stored overall'
SELECT ROUND(SUM(weighted_score), 2) AS weighted_sum,
       (SELECT overall_score FROM gbp_health_scores LIMIT 1) AS stored_overall
FROM gbp_dimension_scores;

ROLLBACK;
