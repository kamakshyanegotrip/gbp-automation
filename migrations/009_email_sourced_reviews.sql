-- ============================================================================
-- MIGRATION 009: Reviews ingested from Google's notification emails
-- Created: 2026-09-20
-- Purpose: The Business Profile API allowlist is still at quota 0, so reviews
--          cannot be read from the API. Google's review-notification emails
--          carry the real review id, account id, location fid, rating,
--          reviewer name and (often truncated) review text — enough to drive
--          the existing reply-drafting pipeline with no API at all.
--
-- Because the emails carry the genuine google_review_id, email-sourced rows
-- reconcile with API-sourced rows instead of duplicating them once the
-- allowlist opens.
-- ============================================================================

BEGIN;

-- Where a review row came from. 'api' is the historical default.
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'api';

-- Notification emails truncate long review text with a trailing ellipsis.
-- A draft written from truncated text must never be auto-sent.
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS comment_truncated BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE gbp_reviews DROP CONSTRAINT IF EXISTS gbp_review_source_valid;
ALTER TABLE gbp_reviews ADD CONSTRAINT gbp_review_source_valid
  CHECK (source IN ('api', 'email'));

COMMENT ON COLUMN gbp_reviews.source IS
  'api = read from the Business Profile API; email = parsed from a Google notification email';
COMMENT ON COLUMN gbp_reviews.comment_truncated IS
  'True when the review text came from a notification email and was cut short by Google';

CREATE INDEX IF NOT EXISTS idx_gbp_reviews_source ON gbp_reviews (source);

-- ----------------------------------------------------------------------------
-- Google identifiers recovered from notification emails.
--
-- Deliberately NOT written over google_account_name / google_location_name.
-- Those drive live API calls, and while the account id is almost certainly
-- correct, it is not certain that `fid` equals the API's locationId. Storing
-- them separately means a wrong guess cannot silently break API calls later;
-- the API fills the authoritative columns when the allowlist opens.
-- ----------------------------------------------------------------------------
ALTER TABLE gbp_locations ADD COLUMN IF NOT EXISTS discovered_account_id   VARCHAR(64);
ALTER TABLE gbp_locations ADD COLUMN IF NOT EXISTS discovered_location_fid VARCHAR(64);

COMMENT ON COLUMN gbp_locations.discovered_account_id IS
  'Account id seen in Google notification email links; unverified against the API';
COMMENT ON COLUMN gbp_locations.discovered_location_fid IS
  'Location fid seen in Google notification email links; may or may not equal the API locationId';

UPDATE gbp_locations
   SET discovered_account_id   = '14183146380584509336',
       discovered_location_fid = '964969879651510777',
       updated_at = now()
 WHERE business_name ILIKE 'Negotrip'
   AND discovered_account_id IS NULL;

COMMIT;
