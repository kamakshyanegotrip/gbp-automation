-- 018_one_review_id_shape.sql
-- ---------------------------------------------------------------------------
-- gbp_reviews held two rows for every review again, and this time it was the
-- audit's fault.
--
-- Three ingest paths write to this table, and until now all three derived
-- google_review_id differently:
--
--   GBP Review Email Ingest   bare id from the notification email
--                             Ci9DQUlRQUNvZENodHlj...
--   GBP Review Response       the FULL resource name from the v4 API
--                             accounts/{a}/locations/{l}/reviews/{id}
--   GBP Main Audit (4 Oct)    the LAST SEGMENT of that resource name
--                             {id}
--
-- The unique constraint is on google_review_id alone, so the audit's rows never
-- matched the Review Response rows and 24 became 48 on the first 4-hourly sync
-- after the API started working.
--
-- The full resource name is the correct one, and not merely by seniority:
-- Review Response publishes with
--     PUT https://mybusiness.googleapis.com/v4/{google_review_id}/reply
-- so only a row carrying the full path can ever be answered. The twelve replies
-- the optimizer drafted on 4 October were sitting on rows that could not
-- publish — approving one would have produced a request to
-- /v4/{bare_id}/reply and failed.
--
-- Nothing reached Google. gbp_review_reply_log holds 50 rows, every one of them
-- outcome 'drafted' and none 'sent', and auto_reply_enabled is false on both
-- profiles.
--
-- This migration keeps the full-path rows, fills the single gap where the audit
-- had a draft and the canonical row did not, and soft-deletes the audit's 24
-- duplicates. Their drafts stay readable on the retired rows.
-- ---------------------------------------------------------------------------

BEGIN;

-- 1. Carry a draft across only where the canonical row has none.
--
-- Eleven of the twelve already carry a Review Response draft, which is left
-- alone: both were written by the same model for the same review, and
-- overwriting one unreviewed draft with another gains nothing. Only Dalpat
-- Purohit's row (no draft at all) is filled.
WITH pairs AS (
  SELECT b.id AS canonical_id, a.ai_suggested_reply, a.sentiment
    FROM gbp_reviews a
    JOIN gbp_reviews b
      ON b.google_review_id LIKE '%/' || a.google_review_id
     AND b.google_review_id LIKE 'accounts/%'
     AND a.google_review_id NOT LIKE 'accounts/%'
     AND b.location_id = a.location_id
   WHERE a.deleted_at IS NULL
     AND b.deleted_at IS NULL
     AND a.ai_suggested_reply IS NOT NULL
     AND b.ai_suggested_reply IS NULL
     AND b.reply_status NOT IN ('sent', 'pending')
)
UPDATE gbp_reviews r
   SET ai_suggested_reply = p.ai_suggested_reply,
       -- 'drafted', never 'pending'. 'pending' is what publishes.
       reply_status       = 'drafted',
       sentiment          = COALESCE(r.sentiment, p.sentiment),
       updated_at         = now()
  FROM pairs p
 WHERE r.id = p.canonical_id;

-- 2. Retire the audit's bare-id duplicates. Soft delete: the rows and their
--    drafts remain, and clearing deleted_at restores them.
UPDATE gbp_reviews a
   SET deleted_at = now(), updated_at = now()
 WHERE a.deleted_at IS NULL
   AND a.google_review_id NOT LIKE 'accounts/%'
   AND EXISTS (
     SELECT 1 FROM gbp_reviews b
      WHERE b.google_review_id LIKE '%/' || a.google_review_id
        AND b.google_review_id LIKE 'accounts/%'
        AND b.location_id = a.location_id
        AND b.deleted_at IS NULL
   );

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
--   SELECT CASE WHEN google_review_id LIKE 'accounts/%' THEN 'full' ELSE 'bare' END AS shape,
--          reply_status, count(*)
--     FROM gbp_reviews WHERE deleted_at IS NULL
--    GROUP BY 1, 2;
--   -- expect: full/awaiting_approval 11, full/drafted 1, full/sent 12. No bare rows.
--
--   SELECT count(*) FROM v_gbp_pending_replies;   -- expect 12
--
-- ---------------------------------------------------------------------------
-- The fix that stops it recurring
-- ---------------------------------------------------------------------------
-- GBP Main Audit's Calculate Health Score now stores r.raw.name whole instead
-- of its last segment, so its upsert collides with Review Response's rows and
-- updates them rather than inserting beside them.
--
-- Still outstanding: GBP Review Email Ingest is active and writes the bare
-- email-derived id, which matches neither of the other two. With the v4 API
-- working, that path is redundant for this profile and should be switched off
-- or taught to resolve its id against the API before inserting. Until then a
-- newly arrived review can still land twice.
