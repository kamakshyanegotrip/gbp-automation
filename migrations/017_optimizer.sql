-- 017_optimizer.sql
-- ---------------------------------------------------------------------------
-- Turns recommendations from something you read into something you can act on.
--
-- Two additions:
--
--   1. gbp_profile_edits gains `categories` and `place_action_links`, so a
--      proposed fix for the additional_categories and place_actions checks has
--      somewhere to live. Both are stored in Google's own shape, like
--      regular_hours and special_hours already are.
--
--   2. gbp_fix_runs records every fix the optimizer generates: which check it
--      answers, what it produced, where it was filed, and what became of it.
--      Without this there is no way to ask "what did the optimizer change and
--      did the score move because of it" — the same question that made the
--      fixture runs so expensive to untangle.
-- ---------------------------------------------------------------------------

BEGIN;

-- --------------------------------------------------------------- new fields --

ALTER TABLE gbp_profile_edits
  ADD COLUMN IF NOT EXISTS categories JSONB;

ALTER TABLE gbp_profile_edits
  ADD COLUMN IF NOT EXISTS place_action_links JSONB;

COMMENT ON COLUMN gbp_profile_edits.categories IS
  'Additional categories in Google''s shape: [{"name":"categories/gcid:x","displayName":"X"}]. '
  'The primary category is deliberately not settable here — changing it can '
  'reset a profile''s eligibility and is not a thing to automate.';
COMMENT ON COLUMN gbp_profile_edits.place_action_links IS
  'Booking and ordering links: [{"placeActionType":"APPOINTMENT","uri":"https://..."}]. '
  'These live on a different API surface from the location PATCH, so the '
  'applier writes them with a separate call.';

-- The old constraint predates these columns, so a row proposing only a
-- category change would have been refused as empty.
ALTER TABLE gbp_profile_edits
  DROP CONSTRAINT IF EXISTS gbp_profile_edit_has_content;

ALTER TABLE gbp_profile_edits
  ADD CONSTRAINT gbp_profile_edit_has_content
  CHECK (description IS NOT NULL
      OR services IS NOT NULL
      OR regular_hours IS NOT NULL
      OR special_hours IS NOT NULL
      OR categories IS NOT NULL
      OR place_action_links IS NOT NULL);

-- ------------------------------------------------------------- the fix log --

CREATE TABLE IF NOT EXISTS gbp_fix_runs (
  id SERIAL PRIMARY KEY,

  location_id INT NOT NULL REFERENCES gbp_locations(id) ON DELETE CASCADE,

  -- Which audit check this fix answers, e.g. 'service_descriptions'.
  -- Not a foreign key to gbp_recommendations on purpose: a recommendation is
  -- closed and re-raised as the check passes and fails again, and the history
  -- of what was tried should outlive any single row.
  check_key   VARCHAR(80) NOT NULL,

  -- Where the generated fix was filed.
  --   profile_edit : a row in gbp_profile_edits
  --   review       : a draft on gbp_reviews.ai_suggested_reply
  --   direct       : applied straight to Google, no human gate
  target      VARCHAR(20) NOT NULL,
  target_id   INT,

  -- What was produced, in full. Kept so a bad batch can be read back and
  -- understood without re-running the model.
  generated   JSONB,

  -- How many items the fix covers — 34 services, 12 replies — so the log is
  -- legible without parsing `generated`.
  item_count  INT,

  model       VARCHAR(80),

  status      VARCHAR(20) NOT NULL DEFAULT 'generated',
  error       TEXT,

  -- The score at the moment of generation, so a later run can say what moved.
  score_before NUMERIC(5,2),
  score_after  NUMERIC(5,2),

  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,

  CONSTRAINT gbp_fix_target_valid
    CHECK (target IN ('profile_edit', 'review', 'direct')),
  CONSTRAINT gbp_fix_status_valid
    CHECK (status IN ('generated', 'queued', 'applied', 'failed', 'discarded')),
  CONSTRAINT gbp_fix_failed_has_reason
    CHECK (status <> 'failed' OR error IS NOT NULL)
);

COMMENT ON TABLE gbp_fix_runs IS
  'Every fix the optimizer generated: which check it answers, what it wrote, '
  'where it went and what happened to it.';

CREATE INDEX IF NOT EXISTS idx_gbp_fix_runs_location
  ON gbp_fix_runs (location_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gbp_fix_runs_open
  ON gbp_fix_runs (location_id, check_key)
  WHERE status IN ('generated', 'queued');

-- One fix in flight per check per location. Generating a second batch of 34
-- service descriptions while the first is still queued would leave two drafts
-- competing for the same profile.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gbp_fix_runs_one_open_per_check
  ON gbp_fix_runs (location_id, check_key)
  WHERE status IN ('generated', 'queued');

-- ---------------------------------------------------------------------------
-- What the console reads: open recommendations with whatever the optimizer has
-- already done about them, so a check that has a fix in flight shows that
-- instead of offering to generate another.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_gbp_fixable AS
SELECT
  r.id                AS recommendation_id,
  r.location_id,
  l.business_name,
  r.dimension_key,
  r.check_key,
  r.priority,
  r.title,
  r.detail,
  r.points_recoverable,
  f.id                AS fix_id,
  f.status            AS fix_status,
  f.target            AS fix_target,
  f.target_id         AS fix_target_id,
  f.item_count        AS fix_item_count,
  f.created_at        AS fix_created_at,
  f.error             AS fix_error
FROM gbp_recommendations r
JOIN gbp_locations l ON l.id = r.location_id
LEFT JOIN LATERAL (
  SELECT * FROM gbp_fix_runs fr
   WHERE fr.location_id = r.location_id
     AND fr.check_key   = r.check_key
   ORDER BY fr.created_at DESC
   LIMIT 1
) f ON TRUE
WHERE r.status = 'open'
  AND r.check_key IS NOT NULL
  AND l.deleted_at IS NULL
ORDER BY r.points_recoverable DESC NULLS LAST;

COMMENT ON VIEW v_gbp_fixable IS
  'Open recommendations joined to the most recent fix attempt for the same '
  'check, so the console can show Fix, In review, or the reason it failed.';

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
--   SELECT check_key, points_recoverable, fix_status FROM v_gbp_fixable;
--   -- 15 rows for Negotrip, every fix_status NULL before the first run
--
--   INSERT INTO gbp_profile_edits (location_id, categories)
--   VALUES (1, '[{"name":"categories/gcid:travel_agency"}]'::jsonb);
--   -- must now be accepted; before 017 the has_content check refused it
