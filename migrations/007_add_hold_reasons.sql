-- ============================================================================
-- MIGRATION 007: Persist the hold reasons that keep a draft from auto-sending
-- Created: 2026-09-05
-- Purpose: Validate Post and Parse Draft both compute a list of reasons a
--          draft may not be published automatically. Those reasons reached the
--          digest email but were never stored, so after the fact there was no
--          way to ask "why was this one held?". gbp_reviews had
--          escalation_reason, but that is only populated for escalations, so a
--          plain hold (auto-reply switched off, model output unparseable,
--          reply too short) left no trace at all.
-- ============================================================================

BEGIN;

ALTER TABLE gbp_posts   ADD COLUMN IF NOT EXISTS hold_reasons JSONB;
ALTER TABLE gbp_reviews ADD COLUMN IF NOT EXISTS hold_reasons JSONB;

COMMENT ON COLUMN gbp_posts.hold_reasons IS
  'JSON array of the reasons Validate Post refused to auto-publish this draft; empty array when it cleared every check';
COMMENT ON COLUMN gbp_reviews.hold_reasons IS
  'JSON array of the reasons Parse Draft refused to auto-send this reply; empty array when it cleared every check';

-- Held rows are the ones worth finding again, so index only those.
CREATE INDEX IF NOT EXISTS idx_gbp_posts_hold_reasons
  ON gbp_posts USING GIN (hold_reasons)
  WHERE hold_reasons IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gbp_reviews_hold_reasons
  ON gbp_reviews USING GIN (hold_reasons)
  WHERE hold_reasons IS NOT NULL;

COMMIT;

-- Verify:
--   SELECT post_id, status, hold_reasons FROM gbp_posts ORDER BY id DESC LIMIT 5;
--   SELECT id, reply_status, hold_reasons FROM gbp_reviews ORDER BY id DESC LIMIT 5;
