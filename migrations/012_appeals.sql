-- ============================================================================
-- MIGRATION 012: Appeals and support cases
-- Created: 2026-10-01
-- Purpose: Record every case opened with Google against a profile, and what
--          came back.
--
-- Why this exists at all. Two cases have been filed for this project so far
-- and both nearly vanished. The first API allowlist case produced no
-- acknowledgement, appeared in no support history, and was eventually treated
-- as never filed — months lost. The 3 June posting-restriction notice then sat
-- unread for three and a half months in a mailbox with ~11,800 unread
-- messages. Neither failure was technical. Both were a missing row.
--
-- Deliberately not limited to appeals: the same shape fits an allowlist
-- request, a reinstatement, a policy query. One row per conversation with
-- Google.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS gbp_appeals (
  id SERIAL PRIMARY KEY,

  location_id INTEGER REFERENCES gbp_locations(id) ON DELETE SET NULL,

  -- Null for a case that is not about one profile — an API allowlist request
  -- belongs to the Cloud project, not to a location.
  client_id   INTEGER REFERENCES gbp_clients(id) ON DELETE SET NULL,

  case_kind   VARCHAR(40)  NOT NULL,

  -- The reference to quote. A case with no reference is not trackable, which
  -- is the whole failure this table exists to prevent — but it is nullable
  -- because a case can legitimately exist for the minutes before Google
  -- returns one.
  case_reference        VARCHAR(100),

  -- Secondary references: Google hands out more than one id per case. The
  -- posting appeal of 2026-10-01 produced 0-8526000042027 on the confirmation
  -- screen and 3-4530000037663 mid-form.
  other_references      TEXT,

  -- The id carried on the original policy notice, where there was one.
  routing_id            VARCHAR(40),

  subject     VARCHAR(255) NOT NULL,
  submitted_text        TEXT,
  channel     VARCHAR(40),

  status      VARCHAR(30) NOT NULL DEFAULT 'open',

  filed_at    TIMESTAMP,
  response_due_at       TIMESTAMP,
  responded_at          TIMESTAMP,
  closed_at             TIMESTAMP,

  outcome               VARCHAR(30),

  -- The actionable part of a refusal. The appeal text asks Google to name the
  -- policy clause precisely so that a rejection still yields something to fix
  -- rather than a guess.
  outcome_clause        TEXT,
  outcome_detail        TEXT,

  -- What this case is blocking, in plain words, so its cost is visible
  -- without reconstructing it from memory.
  blocks                TEXT,

  notes       TEXT,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT gbp_appeal_kind_valid
    CHECK (case_kind IN ('content_restriction', 'suspension', 'reinstatement',
                         'api_allowlist', 'review_removal', 'edit_rejected',
                         'other')),

  CONSTRAINT gbp_appeal_status_valid
    CHECK (status IN ('draft', 'open', 'awaiting_google', 'responded',
                      'closed')),

  -- 'unanswered' is a real outcome, not a missing value. The first allowlist
  -- case ended that way and calling it anything else would have hidden it.
  CONSTRAINT gbp_appeal_outcome_valid
    CHECK (outcome IS NULL OR outcome IN ('granted', 'partial', 'refused',
                                          'unanswered', 'withdrawn')),

  -- A closed case must say how it ended.
  CONSTRAINT gbp_appeal_closed_has_outcome
    CHECK (status <> 'closed' OR outcome IS NOT NULL)
);

COMMENT ON TABLE gbp_appeals IS
  'One row per case opened with Google. Exists because two cases have already '
  'been lost for want of a recorded reference.';
COMMENT ON COLUMN gbp_appeals.case_reference IS
  'The reference to quote when chasing. Without it a case cannot be followed.';
COMMENT ON COLUMN gbp_appeals.outcome_clause IS
  'The policy clause Google named when refusing. The appeal asks for this '
  'explicitly, so that a refusal is still actionable.';
COMMENT ON COLUMN gbp_appeals.response_due_at IS
  'When Google said to expect a decision. Drives the overdue flag; it is not '
  'a promise, and passing it is a prompt to chase, not an error.';

CREATE INDEX IF NOT EXISTS idx_gbp_appeals_open
  ON gbp_appeals (status, response_due_at)
  WHERE status <> 'closed';

CREATE INDEX IF NOT EXISTS idx_gbp_appeals_location
  ON gbp_appeals (location_id, filed_at DESC);

-- One open case per (location, kind). Filing a duplicate is precisely how the
-- first allowlist case became untraceable: two requests, neither referenced.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gbp_appeals_one_open_per_kind
  ON gbp_appeals (location_id, case_kind)
  WHERE status <> 'closed' AND location_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- What the console reads
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_gbp_open_appeals AS
SELECT
  a.id,
  a.location_id,
  l.business_name,
  a.case_kind,
  a.case_reference,
  a.other_references,
  a.routing_id,
  a.subject,
  a.channel,
  a.status,
  a.filed_at,
  a.response_due_at,
  a.responded_at,
  a.outcome,
  a.outcome_clause,
  a.blocks,
  a.notes,

  -- Whole days since filing, so the cost of a stalled case is legible at a
  -- glance rather than inferred from a date.
  CASE WHEN a.filed_at IS NULL THEN NULL
       ELSE EXTRACT(DAY FROM (now() - a.filed_at))::int END AS days_open,

  (a.response_due_at IS NOT NULL
     AND a.response_due_at < now()
     AND a.responded_at IS NULL)                        AS overdue

FROM gbp_appeals a
LEFT JOIN gbp_locations l ON l.id = a.location_id
WHERE a.status <> 'closed'
ORDER BY (a.response_due_at IS NOT NULL AND a.response_due_at < now()) DESC,
         a.filed_at ASC NULLS LAST;

COMMENT ON VIEW v_gbp_open_appeals IS
  'Open cases, overdue first. Closed cases stay in gbp_appeals as the record.';

-- ---------------------------------------------------------------------------
-- Seed: the two cases this project already has
-- ---------------------------------------------------------------------------

-- The posting restriction, filed 2026-10-01 after sitting unactioned since
-- 3 June. Response window is five business days: 8 October.
INSERT INTO gbp_appeals (
  location_id, case_kind, case_reference, other_references, routing_id,
  subject, channel, status, filed_at, response_due_at, blocks, notes
)
SELECT
  l.id,
  'content_restriction',
  '0-8526000042027',
  '3-4530000037663 (shown as case in progress during the form)',
  'DPNB',
  'Posting disabled on Negotrip Business Profile',
  'email',
  'awaiting_google',
  TIMESTAMP '2026-10-01 14:00:00',
  TIMESTAMP '2026-10-08 23:59:59',
  'All posts and photos. GBP Content Management (vwLx3doSaRrtaXIE) cannot '
  'publish by any route — API, Windsor or by hand — while this stands.',
  'The appeals tool refused this: selecting Negotrip returned "No rejected '
  'content to appeal", confirming that outside the UK/EEA it handles profile '
  'suspensions only. Filed through Business Profile Manager -> Help -> '
  'Contact us -> Posts removed -> Email. That flow routes a content '
  'restriction into the suspended-profile evidence form, which demands a '
  'utility bill and tax certificates; those documents are a tollgate, not '
  'the argument. Free-text field caps at 1000 characters.'
FROM gbp_locations l
WHERE l.business_name = 'Negotrip'
  AND NOT EXISTS (SELECT 1 FROM gbp_appeals
                   WHERE case_reference = '0-8526000042027');

-- The API allowlist request. Not tied to a location — it belongs to the Cloud
-- project. Recorded as still open because no decision has ever arrived.
INSERT INTO gbp_appeals (
  location_id, case_kind, case_reference, subject, channel, status,
  filed_at, response_due_at, blocks, notes
)
SELECT
  NULL,
  'api_allowlist',
  '5-4868000041887',
  'GBP API allowlist for gbp-automation-507508',
  'form',
  'awaiting_google',
  TIMESTAMP '2026-09-08 00:00:00',
  TIMESTAMP '2026-09-22 23:59:59',
  'Reviews, local posts and photos — the Google My Business v4 surface. '
  'Business info and performance are v1 and open as soon as quota does.',
  'Stated review time 7-10 business days, which elapsed around 21-22 '
  'September with no reply in kn0733@gmail.com or support@assignover.in. '
  'An earlier case, 5-8076000041296, never acknowledged and absent from the '
  'account support history — treat that one as never filed. Quota page still '
  'reads requests-per-minute 0.'
WHERE NOT EXISTS (SELECT 1 FROM gbp_appeals
                   WHERE case_reference = '5-4868000041887');

COMMIT;

-- ============================================================================
-- Verify
-- ============================================================================
-- SELECT case_reference, case_kind, status, days_open, overdue
--   FROM v_gbp_open_appeals;
--
-- Expect two rows. The allowlist case should show overdue = true and a
-- days_open figure in the twenties; that number is the point of the view.
-- ============================================================================
