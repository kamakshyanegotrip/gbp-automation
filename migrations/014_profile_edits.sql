-- ============================================================================
-- MIGRATION 014: Profile edits requested from the console
-- Created: 2026-10-02
--
-- Until now, changing a profile's description, services or hours meant editing
-- a hardcoded CLIENTS array inside the Apply Profile Content workflow and
-- running it by hand. This makes the desired content a row, so the console can
-- propose a change and the workflow can apply it.
--
-- Why the whole desired state and not a diff. `serviceItems` and `specialHours`
-- are replace-the-whole-list on Google's side — there is no partial update, and
-- a patch that sends a subset silently deletes everything it leaves out. The
-- safe shape is therefore "here is what the list should be", and the workflow
-- still reads the live list and refuses to shrink it (that guard predates this
-- table and stays).
--
-- Note what is NOT here: gbp_locations has no description or hours column, so
-- there is nothing to pre-fill an editor from on a first edit. The audit keeps
-- the live profile only inside raw_snapshot. An applied row becomes the record
-- of what was last set, which is what the console reads back.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS gbp_profile_edits (
  id SERIAL PRIMARY KEY,

  location_id INT NOT NULL REFERENCES gbp_locations(id) ON DELETE CASCADE,

  -- NULL means "leave this part of the profile alone". An empty string is a
  -- different instruction — it would clear the description — so the two are
  -- deliberately not conflated.
  description   TEXT,

  -- [{display_name, description, price_amount_micros, price_currency}]
  services      JSONB,

  -- Kept as sent to Google rather than normalised: these go through to the API
  -- shape and inventing an intermediate format would only add a translation
  -- layer to get wrong.
  regular_hours JSONB,
  special_hours JSONB,

  status VARCHAR(20) NOT NULL DEFAULT 'draft',

  -- Why this change was made, for the audit trail. Free text, operator's words.
  note        TEXT,
  requested_by VARCHAR(255),

  submitted_at TIMESTAMP,
  applied_at   TIMESTAMP,
  apply_error  TEXT,

  -- What the workflow actually sent, captured after a successful apply. Lets a
  -- later question of "what did we change it to in October" be answered without
  -- re-reading Google.
  applied_payload JSONB,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT gbp_profile_edit_status_valid
    CHECK (status IN ('draft', 'pending', 'applied', 'failed', 'cancelled')),

  -- An applied edit must say when; a failed one must say why. Without this a
  -- row can claim success while carrying no evidence of it.
  CONSTRAINT gbp_profile_edit_applied_has_time
    CHECK (status <> 'applied' OR applied_at IS NOT NULL),
  CONSTRAINT gbp_profile_edit_failed_has_reason
    CHECK (status <> 'failed' OR apply_error IS NOT NULL),

  -- A change that proposes nothing is a mistake, not a no-op worth storing.
  CONSTRAINT gbp_profile_edit_has_content
    CHECK (description IS NOT NULL OR services IS NOT NULL
           OR regular_hours IS NOT NULL OR special_hours IS NOT NULL)
);

COMMENT ON TABLE gbp_profile_edits IS
  'A proposed change to a profile''s description, services or hours. The '
  'console writes these; Apply Profile Content reads the pending ones.';
COMMENT ON COLUMN gbp_profile_edits.description IS
  'NULL leaves the description alone. An empty string clears it — not the same '
  'thing, and deliberately distinguishable.';
COMMENT ON COLUMN gbp_profile_edits.applied_payload IS
  'What was actually sent to Google, captured on success.';

-- One pending edit per location. Two queued changes to the same profile would
-- apply in an order nobody chose, and the second would silently win.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gbp_profile_edits_one_pending
  ON gbp_profile_edits (location_id)
  WHERE status = 'pending';

-- Same for drafts: the console edits one draft per profile rather than
-- accumulating a pile of half-finished ones.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gbp_profile_edits_one_draft
  ON gbp_profile_edits (location_id)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS idx_gbp_profile_edits_history
  ON gbp_profile_edits (location_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_gbp_profile_edits_touch ON gbp_profile_edits;
CREATE TRIGGER trg_gbp_profile_edits_touch
  BEFORE UPDATE ON gbp_profile_edits
  FOR EACH ROW EXECUTE FUNCTION gbp_touch_updated_at();

-- ---------------------------------------------------------------------------
-- What the console reads: the live draft or pending edit per location, plus
-- the last thing that was actually applied.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_gbp_profile_edits AS
SELECT
  e.id,
  e.location_id,
  l.business_name,
  e.description,
  e.services,
  e.regular_hours,
  e.special_hours,
  e.status,
  e.note,
  e.submitted_at,
  e.applied_at,
  e.apply_error,
  e.created_at,
  e.updated_at
FROM gbp_profile_edits e
JOIN gbp_locations l ON l.id = e.location_id
WHERE e.status IN ('draft', 'pending', 'failed')
ORDER BY e.location_id, e.created_at DESC;

COMMENT ON VIEW v_gbp_profile_edits IS
  'Edits still in play. A failed one is included on purpose — it needs a human '
  'to look at apply_error, and hiding it would leave the change silently lost.';

COMMIT;

-- ============================================================================
-- Verify
-- ============================================================================
-- Both must be refused:
--   INSERT INTO gbp_profile_edits (location_id) VALUES (1);           -- no content
--   UPDATE gbp_profile_edits SET status='applied' WHERE id=1;         -- no applied_at
--
-- And a second pending row for a location must be refused by
-- idx_gbp_profile_edits_one_pending.
-- ============================================================================
