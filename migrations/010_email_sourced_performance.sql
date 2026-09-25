-- ============================================================================
-- MIGRATION 010: Monthly performance and profile alerts from Google's emails
-- Created: 2026-09-20
-- Purpose: Google mails the profile owner a monthly performance summary and
--          various profile notices. With the API allowlist still at quota 0,
--          these emails are the only free source of performance data — and the
--          mailbox holds 13 months of history going back to August 2025.
--
-- WHY A NEW TABLE: gbp_performance_metrics is DAILY and API-shaped
-- (impressions split by desktop/mobile x maps/search, keyed on metric_date).
-- The email gives MONTHLY totals in a different vocabulary. Writing a monthly
-- total into a daily row would read as one enormous day and silently corrupt
-- every average computed from that table. They stay separate.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS gbp_performance_monthly (
  id SERIAL PRIMARY KEY,

  location_id  INT  NOT NULL REFERENCES gbp_locations(id) ON DELETE CASCADE,
  period_month DATE NOT NULL,           -- always the first of the month

  total_interactions INT,
  calls              INT,
  chat_clicks        INT,
  direction_requests INT,
  website_visits     INT,
  profile_views      INT,
  searches           INT,

  source      VARCHAR(20) NOT NULL DEFAULT 'email',
  report_url  TEXT,
  message_id  VARCHAR(64),

  captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT gbp_perf_monthly_unique UNIQUE (location_id, period_month),
  CONSTRAINT gbp_perf_monthly_source_valid CHECK (source IN ('email', 'api'))
);

COMMENT ON TABLE gbp_performance_monthly IS
  'Monthly performance totals parsed from Google Business Profile summary emails. Distinct from gbp_performance_metrics, which is daily and API-shaped.';

CREATE INDEX IF NOT EXISTS idx_gbp_perf_monthly
  ON gbp_performance_monthly (location_id, period_month DESC);

-- ----------------------------------------------------------------------------
-- Profile notices worth acting on: policy violations, customer photos,
-- holiday-hours prompts. A removed post with posting disabled is the kind of
-- thing that must not sit unread in an inbox.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_profile_alerts (
  id SERIAL PRIMARY KEY,

  location_id INT REFERENCES gbp_locations(id) ON DELETE CASCADE,
  alert_type  VARCHAR(40) NOT NULL,
  severity    VARCHAR(10) NOT NULL DEFAULT 'info',
  subject     TEXT,
  detail      TEXT,
  occurred_at TIMESTAMP,

  message_id      VARCHAR(64) UNIQUE,
  acknowledged_at TIMESTAMP,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT gbp_alert_severity_valid CHECK (severity IN ('info', 'warning', 'critical'))
);

COMMENT ON TABLE gbp_profile_alerts IS
  'Non-review notices parsed from Google Business Profile emails: policy actions, customer photos, holiday-hours prompts';
COMMENT ON COLUMN gbp_profile_alerts.message_id IS
  'Gmail message id; the idempotency key so a notice is recorded once';

CREATE INDEX IF NOT EXISTS idx_gbp_alerts_open
  ON gbp_profile_alerts (location_id, occurred_at DESC) WHERE acknowledged_at IS NULL;

COMMIT;
