-- ============================================================================
-- MIGRATION 011: Multi-tenant foundation
-- Created: 2026-09-22
-- Purpose: Assign Over is the software publisher; each managed business is a
--          client. Until now gbp_locations held one row and every workflow
--          called .first() on it, so a second row would have been silently
--          ignored. This adds the client layer the rest of the rework needs.
--
-- Deliberately additive: nothing here changes existing behaviour. Negotrip is
-- backfilled to a default client so current workflows keep working unchanged
-- while the iteration rework happens separately.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS gbp_clients (
  id SERIAL PRIMARY KEY,

  client_code  VARCHAR(50)  UNIQUE NOT NULL,
  client_name  VARCHAR(255) NOT NULL,

  -- Who to talk to, and where results go
  contact_name   VARCHAR(255),
  contact_email  VARCHAR(255),
  notify_emails  TEXT,

  -- Commercial / lifecycle state
  status         VARCHAR(20) NOT NULL DEFAULT 'active',
  onboarded_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  offboarded_at  TIMESTAMP,

  -- The terms promise deletion within seven business days of termination.
  -- This is the clock that obligation is measured against.
  deletion_due_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT gbp_client_status_valid
    CHECK (status IN ('active', 'paused', 'offboarding', 'closed'))
);

COMMENT ON TABLE gbp_clients IS
  'One row per business Assign Over manages. Locations belong to a client.';
COMMENT ON COLUMN gbp_clients.deletion_due_at IS
  'Seven business days after offboarding started; the terms commit to deletion by this date';

CREATE INDEX IF NOT EXISTS idx_gbp_clients_active
  ON gbp_clients (status) WHERE status = 'active';

-- ----------------------------------------------------------------------------
-- Locations belong to a client. Nullable for now so nothing breaks mid-rework;
-- tightened to NOT NULL once every workflow iterates properly.
-- ----------------------------------------------------------------------------
ALTER TABLE gbp_locations ADD COLUMN IF NOT EXISTS client_id INT REFERENCES gbp_clients(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_gbp_locations_client ON gbp_locations (client_id);

-- ----------------------------------------------------------------------------
-- Whether this OAuth account can actually reach the location. Discovered the
-- hard way: the credential sees exactly one location, so a gbp_locations row
-- is not proof of access. A workflow must skip unreachable locations loudly
-- rather than failing halfway through a run.
-- ----------------------------------------------------------------------------
ALTER TABLE gbp_locations ADD COLUMN IF NOT EXISTS api_reachable BOOLEAN;
ALTER TABLE gbp_locations ADD COLUMN IF NOT EXISTS api_checked_at TIMESTAMP;

COMMENT ON COLUMN gbp_locations.api_reachable IS
  'True when the connected Google account could list this location. NULL = never checked.';

-- ----------------------------------------------------------------------------
-- Backfill: Negotrip becomes the first client
-- ----------------------------------------------------------------------------
INSERT INTO gbp_clients (client_code, client_name, contact_email, notify_emails, status)
VALUES ('negotrip', 'Negotrip', 'kn0733@gmail.com', 'kn0733@gmail.com', 'active')
ON CONFLICT (client_code) DO NOTHING;

UPDATE gbp_locations
   SET client_id = (SELECT id FROM gbp_clients WHERE client_code = 'negotrip'),
       api_reachable = true,
       api_checked_at = now(),
       updated_at = now()
 WHERE business_name ILIKE 'Negotrip'
   AND client_id IS NULL;

COMMIT;
