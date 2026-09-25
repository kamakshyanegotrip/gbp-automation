-- ============================================================================
-- MIGRATION 001: Create GBP Core Tables
-- Created: 2026-09-04
-- Purpose: Foundational tables for Google Business Profile automation —
--          monitored locations and audit run history
-- Project:  gbp-automation-507508 (Google Cloud)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Monitored GBP locations
-- One row per Google Business Profile location under automation.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_locations (
  -- Primary Key
  id SERIAL PRIMARY KEY,
  location_id VARCHAR(50) UNIQUE NOT NULL,

  -- Google identifiers (as returned by the Business Profile APIs)
  -- google_account_name: "accounts/{accountId}"
  -- google_location_name: "locations/{locationId}"
  google_account_name  VARCHAR(255) NOT NULL,
  google_location_name VARCHAR(255) NOT NULL,
  place_id             VARCHAR(255),

  -- Descriptive
  business_name  VARCHAR(255) NOT NULL,
  store_code     VARCHAR(100),
  primary_category VARCHAR(255),
  website_url    VARCHAR(500),
  phone          VARCHAR(30),

  -- Address
  address_lines TEXT,
  city          VARCHAR(100),
  state         VARCHAR(100),
  postal_code   VARCHAR(20),
  country       VARCHAR(100) DEFAULT 'IN',
  latitude      NUMERIC(10, 7),
  longitude     NUMERIC(10, 7),

  -- Automation control
  is_active            BOOLEAN DEFAULT true,
  audit_enabled        BOOLEAN DEFAULT true,
  auto_reply_enabled   BOOLEAN DEFAULT false,
  auto_post_enabled    BOOLEAN DEFAULT false,
  notify_emails        TEXT,

  -- Verification state mirrored from the API
  verification_state VARCHAR(30) DEFAULT 'unknown',

  -- Audit Trail
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_audited_at TIMESTAMP,

  -- Soft Delete Support
  deleted_at TIMESTAMP,

  -- Constraints
  CONSTRAINT gbp_location_unique_google UNIQUE (google_account_name, google_location_name),
  CONSTRAINT gbp_verification_state_valid
    CHECK (verification_state IN ('unknown', 'unverified', 'pending', 'verified', 'suspended'))
);

COMMENT ON TABLE  gbp_locations IS 'Google Business Profile locations under automation';
COMMENT ON COLUMN gbp_locations.location_id IS 'Internal identifier (e.g., gbp_loc_001)';
COMMENT ON COLUMN gbp_locations.google_location_name IS 'Google resource name, format: locations/{locationId}';
COMMENT ON COLUMN gbp_locations.notify_emails IS 'Comma-separated recipients for this location''s alerts';

-- ----------------------------------------------------------------------------
-- Audit runs
-- One row per execution of the GBP Main Audit workflow, per location.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_audit_runs (
  id SERIAL PRIMARY KEY,
  run_id VARCHAR(50) UNIQUE NOT NULL,

  location_id INT NOT NULL REFERENCES gbp_locations(id) ON DELETE CASCADE,

  -- Execution context
  trigger_type      VARCHAR(20) DEFAULT 'scheduled',
  n8n_execution_id  VARCHAR(100),
  n8n_workflow_name VARCHAR(255),

  -- Lifecycle
  status       VARCHAR(20) DEFAULT 'running',
  started_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at  TIMESTAMP,
  duration_ms  INT,

  -- Raw API payload captured for this run (jsonb so we can diff runs later)
  raw_snapshot JSONB,

  -- Failure detail
  error_stage   VARCHAR(100),
  error_message TEXT,

  -- API accounting, useful while quota is limited
  api_calls_made INT DEFAULT 0,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT gbp_run_trigger_valid
    CHECK (trigger_type IN ('scheduled', 'manual', 'webhook', 'backfill')),
  CONSTRAINT gbp_run_status_valid
    CHECK (status IN ('running', 'completed', 'failed', 'partial', 'skipped'))
);

COMMENT ON TABLE  gbp_audit_runs IS 'Execution history for the GBP Main Audit workflow';
COMMENT ON COLUMN gbp_audit_runs.raw_snapshot IS 'Full API response captured at run time, for diffing and replay';
COMMENT ON COLUMN gbp_audit_runs.status IS 'partial = some dimensions scored, others failed (e.g. reviews 403 while quota pending)';

-- ----------------------------------------------------------------------------
-- Keep updated_at honest
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION gbp_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gbp_locations_touch ON gbp_locations;
CREATE TRIGGER trg_gbp_locations_touch
  BEFORE UPDATE ON gbp_locations
  FOR EACH ROW EXECUTE FUNCTION gbp_touch_updated_at();

COMMIT;

-- Verification query
-- SELECT * FROM gbp_locations LIMIT 0;
-- SELECT * FROM gbp_audit_runs LIMIT 0;
