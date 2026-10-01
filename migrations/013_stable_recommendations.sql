-- ============================================================================
-- MIGRATION 013: Give a recommendation a stable identity
-- Created: 2026-10-01
--
-- The bug. `recommendation_id` is built as
--     'reco_' || health_score_id || '_' || dimension_key || '_' || check_key
-- and health_score_id is new on every audit. So ON CONFLICT (recommendation_id)
-- could never fire, and each run inserted a complete fresh set of every failing
-- check. Three runs left 67 open rows for 23 real checks, which inflated both
-- the open count and the recoverable-points total threefold.
--
-- It was being papered over twice: a "Supersede Old Recommendations" node
-- dismissing the older copies after each run, and a DISTINCT ON in the console
-- query. Both work. Neither is the identity the table should have had.
--
-- The second bug, found while fixing the first. Nothing ever closed a
-- recommendation once its check started passing. A passing check simply does
-- not appear in the payload, so the open row from the previous run was never
-- touched — not by the insert, and not by the supersede node, which only
-- dismissed duplicates of checks that were still failing. Every issue ever
-- raised stayed open forever, including the ones already fixed.
--
-- The fix is to stop treating identity as a string and state it as a
-- constraint: at most one OPEN recommendation per (location, check). The
-- insert then upserts against that, and a separate step closes the rows this
-- run did not re-raise.
--
-- `recommendation_id` is deliberately left alone. Rewriting it across history
-- would collide with the UNIQUE constraint, because dismissed rows share a
-- (location, check) with the open one. It stays unique per insert and is no
-- longer load-bearing.
-- ============================================================================

BEGIN;

-- Which audit last re-raised this recommendation. The insert stamps it every
-- run, so a row whose stamp is older than the newest score for its location is
-- a check that has started passing.
ALTER TABLE gbp_recommendations
  ADD COLUMN IF NOT EXISTS last_seen_health_score_id INT
    REFERENCES gbp_health_scores(id) ON DELETE SET NULL;

COMMENT ON COLUMN gbp_recommendations.last_seen_health_score_id IS
  'The audit that most recently re-raised this check. Older than the latest '
  'score for the location means the check now passes and the row can close.';

-- Existing rows were last seen by the audit that created them.
UPDATE gbp_recommendations
   SET last_seen_health_score_id = health_score_id
 WHERE last_seen_health_score_id IS NULL;

-- --------------------------------------------------------------------------
-- The index cannot be created while duplicates exist, so close them first.
-- This is the same rule the supersede node applied: keep the newest open row
-- per (location, check), dismiss the rest.
-- --------------------------------------------------------------------------
WITH keep AS (
  SELECT DISTINCT ON (location_id, check_key) id
    FROM gbp_recommendations
   WHERE status = 'open' AND check_key IS NOT NULL
   ORDER BY location_id, check_key, created_at DESC, id DESC
)
UPDATE gbp_recommendations r
   SET status = 'dismissed',
       resolved_at = now(),
       resolved_note = 'superseded by a later audit run (cleared for migration 013)',
       updated_at = now()
 WHERE r.status = 'open'
   AND r.check_key IS NOT NULL
   AND r.id NOT IN (SELECT id FROM keep);

-- The real identity. Partial, so history is untouched: a resolved or dismissed
-- row does not block the same check being raised again if it regresses, which
-- is the behaviour we want.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gbp_reco_one_open_per_check
  ON gbp_recommendations (location_id, check_key)
  WHERE status = 'open' AND check_key IS NOT NULL;

COMMENT ON INDEX idx_gbp_reco_one_open_per_check IS
  'At most one open recommendation per location per check. The audit upserts '
  'against this; it is what makes a recommendation keep its created_at, and '
  'therefore its true age, across runs.';

COMMIT;

-- ============================================================================
-- Verify
-- ============================================================================
-- Expect zero rows — if any appear the index would not have been creatable:
--
--   SELECT location_id, check_key, count(*)
--     FROM gbp_recommendations
--    WHERE status = 'open' AND check_key IS NOT NULL
--    GROUP BY 1, 2 HAVING count(*) > 1;
--
-- And after the next audit, open rows should keep their original created_at
-- rather than all sharing the run's timestamp:
--
--   SELECT check_key, created_at, updated_at, last_seen_health_score_id
--     FROM gbp_recommendations WHERE status = 'open' ORDER BY created_at;
-- ============================================================================
