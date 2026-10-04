-- 016_reconcile_review_sources.sql
-- ---------------------------------------------------------------------------
-- gbp_reviews held two rows for every review.
--
-- Until 4 Oct 2026 the audit fetched all 24 reviews with their reply state and
-- then threw the rows away, keeping only aggregate counts. The only per-review
-- rows came from Google's notification EMAILS, which carry a different review
-- identifier from the one the API returns:
--
--   email : Ci9DQUlRQUNvZENodHljRjlvT2s5UFNYSm5VMmhSTlZVMllqWkpTbkp6Wmt0Q1kwRRAB
--   api   : the last segment of  accounts/{a}/locations/{l}/reviews/{id}
--
-- They do not match, so when the audit began upserting reviews on
-- google_review_id it inserted 24 new rows beside the 24 email rows instead of
-- updating them: 28 rows became 52 and the console queue went from 27 to 39.
--
-- The API rows are the authoritative set. They agree with Google exactly:
-- 24 reviews, 12 answered, 12 not. The email rows never knew about replies
-- made in the Google UI — 22 of them sat in the queue as awaiting_approval,
-- and half of those were already answered.
--
-- This migration keeps the API rows, carries the operator's drafted replies
-- across to them, and soft-deletes the email rows and the four fixture rows
-- that reference the test location accounts/106/locations/123. Nothing is hard
-- deleted; every retired row keeps its content and can be restored by clearing
-- deleted_at.
-- ---------------------------------------------------------------------------

BEGIN;

-- 1. Carry drafted replies from each email row to its API twin.
--
-- Matched case-insensitively on reviewer name plus star rating, within the same
-- location. 20 of 24 pair up; the other 4 are reviewers who have since renamed
-- their Google account ("TaoCorporate Consultant" -> "TAO") and all 4 of those
-- API rows are already answered, so there is no draft worth carrying.
--
-- Only rows the API reports as UNANSWERED receive a draft. A review Google
-- already shows a reply to must not re-enter the queue.
WITH pairs AS (
  SELECT DISTINCT ON (a.id)
         a.id AS api_id,
         e.ai_suggested_reply,
         e.sentiment
    FROM gbp_reviews a
    JOIN gbp_reviews e
      ON e.source = 'email'
     AND e.deleted_at IS NULL
     AND e.location_id = a.location_id
     AND e.star_rating = a.star_rating
     AND lower(btrim(e.reviewer_display_name)) = lower(btrim(a.reviewer_display_name))
   WHERE a.source = 'api'
     AND a.deleted_at IS NULL
     AND a.google_review_id NOT LIKE 'accounts/106/%'
     AND a.reply_status = 'none'
     AND e.ai_suggested_reply IS NOT NULL
   ORDER BY a.id, e.review_created_at DESC
)
UPDATE gbp_reviews r
   SET ai_suggested_reply = p.ai_suggested_reply,
       -- 'drafted', not 'awaiting_approval': the text was written against the
       -- email copy of the review and deserves a fresh look. Never 'pending' —
       -- that is what the Review Response workflow publishes.
       reply_status       = 'drafted',
       sentiment          = COALESCE(r.sentiment, p.sentiment),
       updated_at         = now()
  FROM pairs p
 WHERE r.id = p.api_id;

-- 2. Retire the email-sourced duplicates.
UPDATE gbp_reviews
   SET deleted_at = now(), updated_at = now()
 WHERE source = 'email'
   AND deleted_at IS NULL;

-- 3. Retire the fixture reviews. They belong to locations/123, a business that
--    does not exist, and three of them were sitting in the operator's queue.
UPDATE gbp_reviews
   SET deleted_at = now(), updated_at = now()
 WHERE google_review_id LIKE 'accounts/106/locations/123/reviews/%'
   AND deleted_at IS NULL;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
--   SELECT source, reply_status, count(*)
--     FROM gbp_reviews WHERE deleted_at IS NULL
--    GROUP BY source, reply_status;
--   -- expect: api/none + api/drafted = 12, api/sent = 12, nothing else
--
--   SELECT count(*) FROM v_gbp_pending_replies;   -- expect 12
--
-- ---------------------------------------------------------------------------
-- Still open after this migration
-- ---------------------------------------------------------------------------
-- The email ingestion path in the Review Response workflow can still create a
-- second row for a review the API already has, because the two identifier
-- schemes do not match. Now that the Google My Business API is enabled and the
-- audit syncs every review on each run, email ingestion is a fallback that is
-- no longer needed for this location and should either be switched off or
-- taught to match on (location_id, reviewer, rating, created date) before it
-- inserts.
--
-- The console builds a business.google.com deep link only for source = 'email'
-- rows. With those retired, that link disappears from the queue; the API rows
-- carry google_review_id and discovered_account_id is on gbp_locations, so the
-- same link can be rebuilt for source = 'api' when someone wants it back.
