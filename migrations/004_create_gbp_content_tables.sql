-- ============================================================================
-- MIGRATION 004: Create GBP Content, Media and Performance Tables
-- Created: 2026-09-04
-- Purpose: Local posts, photos and performance metrics for the
--          GBP Content Management workflow and the Photos/Content dimensions
--
-- API NOTES
--   Local posts : My Business API v4  /v4/{parent}/localPosts        (allowlisted)
--   Media       : My Business API v4  /v4/{parent}/media             (allowlisted)
--   Performance : businessprofileperformance.googleapis.com v1       (enabled)
--   Services    : mybusinessbusinessinformation v1, location.serviceItems
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Local posts
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_posts (
  id SERIAL PRIMARY KEY,
  post_id VARCHAR(50) UNIQUE NOT NULL,

  location_id INT NOT NULL REFERENCES gbp_locations(id) ON DELETE CASCADE,

  -- Present once published
  google_post_name VARCHAR(255) UNIQUE,

  -- Content
  topic_type   VARCHAR(20) NOT NULL DEFAULT 'STANDARD',
  summary      TEXT NOT NULL,
  language_code VARCHAR(10) DEFAULT 'en',

  -- Call to action
  cta_type VARCHAR(30),
  cta_url  VARCHAR(500),

  -- Media attached to the post
  media_url  VARCHAR(500),
  media_type VARCHAR(20),

  -- Event / offer extras
  event_title    VARCHAR(255),
  event_start_at TIMESTAMP,
  event_end_at   TIMESTAMP,
  offer_coupon_code VARCHAR(100),
  offer_terms       TEXT,

  -- Lifecycle
  status        VARCHAR(20) DEFAULT 'draft',
  scheduled_for TIMESTAMP,
  published_at  TIMESTAMP,
  publish_error TEXT,
  publish_attempts INT DEFAULT 0,

  -- Provenance
  generated_by VARCHAR(20) DEFAULT 'automation',
  model_used   VARCHAR(100),

  n8n_execution_id VARCHAR(100),

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP,

  CONSTRAINT gbp_post_topic_valid
    CHECK (topic_type IN ('STANDARD', 'EVENT', 'OFFER', 'ALERT')),
  CONSTRAINT gbp_post_status_valid
    CHECK (status IN ('draft', 'awaiting_approval', 'scheduled', 'published', 'failed', 'rejected', 'expired')),
  CONSTRAINT gbp_post_cta_valid
    CHECK (cta_type IS NULL OR cta_type IN
      ('BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL', 'GET_OFFER')),
  CONSTRAINT gbp_post_event_window
    CHECK (event_end_at IS NULL OR event_start_at IS NULL OR event_end_at >= event_start_at)
);

COMMENT ON TABLE  gbp_posts IS 'Local posts drafted, scheduled and published by the content workflow';
COMMENT ON COLUMN gbp_posts.google_post_name IS 'Google resource name once published: accounts/{a}/locations/{l}/localPosts/{p}';
COMMENT ON COLUMN gbp_posts.status IS 'awaiting_approval is used when auto_post_enabled is false on the location';

-- ----------------------------------------------------------------------------
-- Photos / media inventory
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_media (
  id SERIAL PRIMARY KEY,

  location_id INT NOT NULL REFERENCES gbp_locations(id) ON DELETE CASCADE,
  google_media_name VARCHAR(255) UNIQUE NOT NULL,

  media_format VARCHAR(20),
  category     VARCHAR(40),

  google_url    VARCHAR(1000),
  thumbnail_url VARCHAR(1000),

  width_px  INT,
  height_px INT,

  -- Attribution / source
  is_owner_uploaded BOOLEAN DEFAULT true,

  -- Engagement, when the API returns insights
  view_count INT,

  media_created_at TIMESTAMP,
  first_seen_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_synced_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at       TIMESTAMP,

  CONSTRAINT gbp_media_format_valid
    CHECK (media_format IS NULL OR media_format IN ('PHOTO', 'VIDEO')),
  CONSTRAINT gbp_media_category_valid
    CHECK (category IS NULL OR category IN
      ('COVER', 'PROFILE', 'LOGO', 'EXTERIOR', 'INTERIOR', 'PRODUCT',
       'AT_WORK', 'FOOD_AND_DRINK', 'MENU', 'COMMON_AREA', 'ROOMS',
       'TEAMS', 'ADDITIONAL'))
);

COMMENT ON TABLE  gbp_media IS 'Photo and video inventory feeding the Photos dimension (20%)';
COMMENT ON COLUMN gbp_media.is_owner_uploaded IS 'False for customer-contributed media, which does not count toward coverage';

-- ----------------------------------------------------------------------------
-- Service items
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_services (
  id SERIAL PRIMARY KEY,

  location_id INT NOT NULL REFERENCES gbp_locations(id) ON DELETE CASCADE,

  service_key   VARCHAR(255) NOT NULL,
  display_name  VARCHAR(255) NOT NULL,
  description   TEXT,

  is_free_form BOOLEAN DEFAULT false,
  category     VARCHAR(255),

  price_amount_micros BIGINT,
  price_currency      VARCHAR(10),

  last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at     TIMESTAMP,

  CONSTRAINT gbp_service_unique_per_location UNIQUE (location_id, service_key)
);

COMMENT ON TABLE gbp_services IS 'Service items feeding the Services dimension (10%)';

-- ----------------------------------------------------------------------------
-- Daily performance metrics
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS gbp_performance_metrics (
  id SERIAL PRIMARY KEY,

  location_id INT NOT NULL REFERENCES gbp_locations(id) ON DELETE CASCADE,
  metric_date DATE NOT NULL,

  -- Business Profile Performance API daily metrics
  business_impressions_desktop_maps   INT DEFAULT 0,
  business_impressions_desktop_search INT DEFAULT 0,
  business_impressions_mobile_maps    INT DEFAULT 0,
  business_impressions_mobile_search  INT DEFAULT 0,

  business_conversations   INT DEFAULT 0,
  business_direction_requests INT DEFAULT 0,
  call_clicks              INT DEFAULT 0,
  website_clicks           INT DEFAULT 0,
  business_bookings        INT DEFAULT 0,

  captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT gbp_metrics_unique_day UNIQUE (location_id, metric_date)
);

COMMENT ON TABLE gbp_performance_metrics IS 'Daily metrics from businessprofileperformance.googleapis.com';

DROP TRIGGER IF EXISTS trg_gbp_posts_touch ON gbp_posts;
CREATE TRIGGER trg_gbp_posts_touch
  BEFORE UPDATE ON gbp_posts
  FOR EACH ROW EXECUTE FUNCTION gbp_touch_updated_at();

COMMIT;

-- Verification query
-- SELECT * FROM gbp_posts LIMIT 0;
-- SELECT * FROM gbp_media LIMIT 0;
-- SELECT * FROM gbp_performance_metrics LIMIT 0;
