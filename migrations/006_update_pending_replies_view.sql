-- ============================================================================
-- MIGRATION 006: Include retryable failed sends in the reply queue view
-- Created: 2026-09-04
-- Purpose: A reply whose send failed (a 403 while the GBP allowlist is still
--          pending is the common case) was dropping out of
--          v_gbp_pending_replies entirely, so it was never retried and never
--          surfaced to a human. It now reappears until three send attempts
--          have failed, after which it is treated as needing manual handling.
-- ============================================================================

BEGIN;

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
  ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - rv.review_created_at)) / 3600.0, 2) AS hours_waiting,
  (SELECT count(*) FROM gbp_review_reply_log lg
     WHERE lg.review_id = rv.id AND lg.outcome = 'failed') AS failed_attempts
FROM gbp_reviews rv
JOIN gbp_locations l ON l.id = rv.location_id
WHERE rv.deleted_at IS NULL
  AND l.deleted_at IS NULL
  AND (
    rv.reply_status IN ('none', 'pending', 'drafted', 'awaiting_approval')
    OR (rv.reply_status = 'failed' AND (
          SELECT count(*) FROM gbp_review_reply_log lg
          WHERE lg.review_id = rv.id AND lg.outcome = 'failed') < 3)
  )
ORDER BY rv.requires_escalation DESC, rv.review_created_at ASC;

COMMENT ON VIEW v_gbp_pending_replies IS
  'Review reply queue: escalations first, then oldest. Includes failed sends until three attempts have failed.';

COMMIT;

-- Verification query
-- SELECT reply_status, failed_attempts, count(*) FROM v_gbp_pending_replies GROUP BY 1,2;
