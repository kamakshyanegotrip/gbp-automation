#!/usr/bin/env python3
"""Generate the GBP Main Audit workflow JSON for n8n import."""
import json, pathlib

CRED_GOOGLE = {"id": "pMOKted8v0rROW9p", "name": "GBP Automation OAuth"}
CRED_PG     = {"id": "73038PPSx78LOwXp", "name": "GBP Postgres"}
CRED_GMAIL  = {"id": "kSrGTNfsbOFylPXx", "name": "Gmail - info@negotrip.com"}
CRED_ANTHROPIC = {"id": "B1UfRtUbk4dYzhuw", "name": "Anthropic API"}

SCORER = pathlib.Path("scoring/health-score.js").read_text()
# Strip the module.exports block — n8n's Code sandbox has no module system.
SCORER = SCORER.split("module.exports")[0].rstrip()

ASSEMBLE = SCORER + r"""

// ---------------------------------------------------------------------------
// n8n glue: gather the fetched payloads, score, and shape rows for Postgres
// ---------------------------------------------------------------------------
const run = $('Start Audit Run').first().json;
const now = new Date().toISOString();

// A node may emit several items when HTTP pagination is on, so read them all.
// An error item means the call genuinely failed — that is different from a
// successful call that simply returned nothing, and only the former is
// "degraded".
function fetchPages(nodeName) {
  let items;
  try {
    items = $(nodeName).all().map((i) => i.json);
  } catch (e) {
    return { ok: false, pages: [] };
  }
  const failed = items.some(
    (v) => !v || v.error !== undefined || (typeof v.code === 'number' && v.code >= 400)
  );
  return { ok: !failed, pages: items.filter((v) => v && v.error === undefined) };
}

const locationFetch = fetchPages('Fetch Location Details');
const attrFetch     = fetchPages('Fetch Attributes');
const mediaFetch    = fetchPages('Fetch Media');
const reviewsFetch  = fetchPages('Fetch Reviews');
const perfFetch     = fetchPages('Fetch Performance');

const locationRes = locationFetch.pages[0];
if (!locationRes || !locationRes.name) {
  throw new Error(
    'Business Information API returned no location. If this is a 403 or an empty body, ' +
    'check the quota page — 0 requests/minute means the GBP allowlist is still pending.'
  );
}

const performanceRes = perfFetch.pages[0] || {};

// Anything that genuinely errored downgrades the run to "partial".
const degraded = [];
if (!attrFetch.ok)    degraded.push('attributes');
if (!mediaFetch.ok)   degraded.push('media');
if (!reviewsFetch.ok) degraded.push('reviews');
if (!perfFetch.ok)    degraded.push('performance');

// Attributes live on their own endpoint, not on the Location resource.
const attributes = attrFetch.pages.reduce(
  (acc, p) => acc.concat(p.attributes || []), []
);

// --- media rows -------------------------------------------------------------
const mediaItems = mediaFetch.pages.reduce(
  (acc, p) => acc.concat(p.mediaItems || []), []
);
const media = mediaItems.map((m) => ({
  google_media_name: m.name,
  media_format: m.mediaFormat,
  category: m.locationAssociation && m.locationAssociation.category
    ? m.locationAssociation.category
    : 'ADDITIONAL',
  google_url: m.googleUrl,
  thumbnail_url: m.thumbnailUrl,
  width_px: m.dimensions ? m.dimensions.widthPixels : null,
  height_px: m.dimensions ? m.dimensions.heightPixels : null,
  is_owner_uploaded: m.sourceUrl !== undefined || m.dataRef !== undefined ? true : true,
  media_created_at: m.createTime,
  view_count: m.insights ? Number(m.insights.viewCount || 0) : null,
}));

// --- review stats -----------------------------------------------------------
const reviews = reviewsFetch.pages.reduce(
  (acc, p) => acc.concat(p.reviews || []), []
);
const reviewsHeader = reviewsFetch.pages[0] || {};
const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const parsed = reviews.map((r) => {
  const rating = STAR[r.starRating] || Number(r.starRating) || 0;
  const created = r.createTime;
  const replied = r.reviewReply ? r.reviewReply.updateTime : null;
  const latency = created && replied
    ? (new Date(replied) - new Date(created)) / 3600000
    : null;
  return { rating, created, replied, latency, raw: r };
});
const withReply = parsed.filter((r) => r.replied);
const latencies = withReply.map((r) => r.latency).filter((n) => n !== null).sort((a, b) => a - b);
const median = latencies.length
  ? Math.round(latencies[Math.floor(latencies.length / 2)] * 100) / 100
  : null;
const totalReviews = parsed.length;
const avg = totalReviews
  ? Math.round((parsed.reduce((s, r) => s + r.rating, 0) / totalReviews) * 100) / 100
  : null;
const thirtyAgo = new Date(Date.parse(now) - 30 * 86400000);

// Rating and reply rate are derived from the reviews actually fetched, so the
// two never disagree. totalReviewCount is reported separately for reference.
const reportedTotal = reviewsHeader.totalReviewCount !== undefined
  ? Number(reviewsHeader.totalReviewCount)
  : totalReviews;
if (reviewsFetch.ok && reportedTotal > totalReviews) {
  degraded.push('reviews_truncated');
}

const reviewStats = {
  total_reviews: reportedTotal,
  fetched_reviews: totalReviews,
  average_rating: reviewsHeader.averageRating !== undefined
    ? Number(reviewsHeader.averageRating)
    : avg,
  count_5_star: parsed.filter((r) => r.rating === 5).length,
  count_4_star: parsed.filter((r) => r.rating === 4).length,
  count_3_star: parsed.filter((r) => r.rating === 3).length,
  count_2_star: parsed.filter((r) => r.rating === 2).length,
  count_1_star: parsed.filter((r) => r.rating === 1).length,
  reviews_with_reply: withReply.length,
  response_rate: totalReviews
    ? Math.round((withReply.length / totalReviews) * 10000) / 100
    : null,
  median_response_hours: median,
  reviews_last_30_days: parsed.filter((r) => r.created && new Date(r.created) >= thirtyAgo).length,
  unanswered_count: parsed.filter((r) => !r.replied).length,
  oldest_unanswered_at: parsed.filter((r) => !r.replied)
    .map((r) => r.created).sort()[0] || null,
};

// --- services from the location resource ------------------------------------
const services = (locationRes.serviceItems || []).map((s, i) => ({
  service_key: s.structuredServiceItem
    ? s.structuredServiceItem.serviceTypeId
    : (s.freeFormServiceItem && s.freeFormServiceItem.label
        ? s.freeFormServiceItem.label.displayName
        : 'service_' + i),
  display_name: s.freeFormServiceItem && s.freeFormServiceItem.label
    ? s.freeFormServiceItem.label.displayName
    : (s.structuredServiceItem ? s.structuredServiceItem.serviceTypeId : 'Service ' + i),
  description: s.freeFormServiceItem && s.freeFormServiceItem.label
    ? s.freeFormServiceItem.label.description
    : (s.structuredServiceItem ? s.structuredServiceItem.description : null),
  price_amount_micros: s.price ? Number(s.price.units || 0) * 1000000 : null,
  price_currency: s.price ? s.price.currencyCode : null,
}));

// --- daily performance rows -------------------------------------------------
// fetchMultiDailyMetricTimeSeries returns one series per metric; pivot them
// into one row per date so they map onto gbp_performance_metrics.
const METRIC_COLUMN = {
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS:   'business_impressions_desktop_maps',
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'business_impressions_desktop_search',
  BUSINESS_IMPRESSIONS_MOBILE_MAPS:    'business_impressions_mobile_maps',
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH:  'business_impressions_mobile_search',
  BUSINESS_CONVERSATIONS:              'business_conversations',
  BUSINESS_DIRECTION_REQUESTS:         'business_direction_requests',
  CALL_CLICKS:                         'call_clicks',
  WEBSITE_CLICKS:                      'website_clicks',
  BUSINESS_BOOKINGS:                   'business_bookings',
};

const perfByDate = {};
(performanceRes.multiDailyMetricTimeSeries || []).forEach((block) => {
  (block.dailyMetricTimeSeries || []).forEach((series) => {
    const column = METRIC_COLUMN[series.dailyMetric];
    if (!column) return;
    const dated = (series.timeSeries && series.timeSeries.datedValues) || [];
    dated.forEach((dv) => {
      const d = dv.date || {};
      if (!d.year || !d.month || !d.day) return;
      const key = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
      if (!perfByDate[key]) perfByDate[key] = { metric_date: key };
      perfByDate[key][column] = Number(dv.value || 0);
    });
  });
});
const performanceRows = Object.values(perfByDate);

// --- posts already recorded in our own database -----------------------------
const posts = $('Get Recent Posts').all().map((i) => i.json).filter((p) => p.status);

// --- score ------------------------------------------------------------------
const result = scoreLocation({
  location: Object.assign({}, locationRes, {
    attributes,
    verification_state: run.verification_state,
  }),
  media,
  reviewStats,
  posts,
  services,
  now,
  previousScore: run.previous_score,
});

// --- payload for the Postgres writer ---------------------------------------
return [{
  json: {
    run_db_id: run.run_db_id,
    location_db_id: run.location_db_id,
    business_name: run.business_name,
    notify_emails: run.notify_emails,
    status: degraded.length ? 'partial' : 'completed',
    degraded,
    api_calls_made: locationFetch.pages.length + attrFetch.pages.length
      + mediaFetch.pages.length + reviewsFetch.pages.length + perfFetch.pages.length,
    raw_snapshot: {
      location: locationRes,
      attributes,
      media_count: media.length,
      review_count: reviewStats.total_reviews,
      performance: performanceRes,
    },
    review_stats: reviewStats,
    score: result,
    payload: {
      score: {
        run_id: run.run_db_id,
        location_id: run.location_db_id,
        overall_score: result.overall_score,
        grade: result.grade,
        business_info_score: result.business_info_score,
        photos_score: result.photos_score,
        reviews_score: result.reviews_score,
        profile_score: result.profile_score,
        content_score: result.content_score,
        services_score: result.services_score,
        previous_score: result.previous_score,
        score_delta: result.score_delta,
      },
      dimensions: result.dimensions,
      recommendations: result.recommendations,
      review_stats: reviewStats,
      // The three tables Workflow 3 reads for grounding. Without these the
      // content workflow has no services to write about and no photo to
      // attach, which is the whole point of grounding it in real data.
      media,
      services,
      performance: performanceRows,
      // Only reconcile removals when the fetch actually succeeded — a 403
      // must never be read as "the profile has no photos".
      media_ok: mediaFetch.ok,
      services_ok: true,
    },
  },
}];
"""

EMAIL_CODE = r"""
const d = $('Calculate Health Score').first().json;
const s = d.score;
const claude = (() => {
  try {
    const c = $('Claude Summary').first().json;
    if (c && c.content && c.content[0] && c.content[0].text) return c.content[0].text;
  } catch (e) {}
  return null;
})();

const GRADE_COLOUR = { A: '#1a7f37', B: '#3f7d20', C: '#9a6700', D: '#bc4c00', F: '#cf222e' };
const colour = GRADE_COLOUR[s.grade] || '#57606a';

const arrow = s.score_delta === null ? ''
  : s.score_delta > 0 ? ` &#9650; +${s.score_delta}`
  : s.score_delta < 0 ? ` &#9660; ${s.score_delta}`
  : ' no change';

const rows = s.dimensions.map((dim) => {
  const pct = Math.round(dim.raw_score);
  const bar = Math.round(dim.raw_score);
  return `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;">${dim.dimension_key.replace(/_/g, ' ')}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;width:140px;">
      <div style="background:#eee;height:8px;border-radius:4px;">
        <div style="background:${colour};height:8px;width:${bar}%;border-radius:4px;"></div>
      </div>
    </td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${pct}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#57606a;">${dim.weight_percent}%</td>
  </tr>`;
}).join('');

const fixes = s.recommendations.slice(0, 8).map((r) =>
  `<li style="margin-bottom:6px;">
     <strong>+${r.points_recoverable} pts</strong>
     <span style="color:#57606a;">[${r.priority}]</span>
     ${r.title} &mdash; <span style="color:#57606a;">${r.detail || ''}</span>
   </li>`).join('');

const warning = d.degraded && d.degraded.length
  ? `<p style="background:#fff8c5;border:1px solid #d4a72c;padding:10px;border-radius:6px;">
       Partial run: ${d.degraded.join(' and ')} could not be fetched. The Google My Business v4
       API returns 403 until the project allowlist is approved, so those dimensions scored 0.
     </p>` : '';

const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;">
  <h2 style="margin-bottom:4px;">${d.business_name} &mdash; Profile Health</h2>
  <p style="color:#57606a;margin-top:0;">Audit run ${d.run_db_id} &middot; ${new Date().toDateString()}</p>
  ${warning}
  <div style="font-size:44px;font-weight:700;color:${colour};line-height:1;">
    ${s.overall_score}<span style="font-size:20px;color:#57606a;">/100</span>
    <span style="font-size:24px;">(${s.grade})</span>
  </div>
  <p style="color:#57606a;margin-top:4px;">${arrow}</p>
  <table style="border-collapse:collapse;width:100%;margin-top:16px;font-size:14px;">
    <thead><tr>
      <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;">Dimension</th>
      <th style="border-bottom:2px solid #ddd;"></th>
      <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #ddd;">Score</th>
      <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #ddd;">Weight</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <h3 style="margin-top:24px;">Highest-impact fixes</h3>
  <ol style="font-size:14px;padding-left:20px;">${fixes || '<li>Nothing outstanding.</li>'}</ol>
  ${claude ? `<h3 style="margin-top:24px;">Analysis</h3>
    <div style="font-size:14px;white-space:pre-wrap;background:#f6f8fa;padding:12px;border-radius:6px;">${claude}</div>` : ''}
  <p style="color:#8b949e;font-size:12px;margin-top:24px;">
    Generated by the GBP Main Audit workflow.
  </p>
</div>`;

return [{ json: { html, subject: `[GBP] ${d.business_name}: ${s.overall_score}/100 (${s.grade})`, to: d.notify_emails, ai_summary: claude } }];
"""

# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------
SQL_GET_LOCATIONS = """SELECT
  l.id                    AS location_db_id,
  l.location_id,
  l.google_account_name,
  l.google_location_name,
  l.business_name,
  l.verification_state,
  COALESCE(l.notify_emails, 'kn0733@gmail.com') AS notify_emails,
  (SELECT overall_score FROM gbp_health_scores hs
     WHERE hs.location_id = l.id ORDER BY hs.scored_at DESC LIMIT 1) AS previous_score
FROM gbp_locations l
WHERE l.is_active
  AND l.audit_enabled
  AND l.deleted_at IS NULL;"""

SQL_START_RUN = """WITH ins AS (
  INSERT INTO gbp_audit_runs (run_id, location_id, trigger_type, n8n_execution_id, n8n_workflow_name, status)
  VALUES (
    -- Random suffix so two runs starting in the same second (a manual re-run
    -- alongside the schedule) cannot collide on the unique constraint.
    'run_' || to_char(now(), 'YYYYMMDD_HH24MISS') || '_' || $1::text
      || '_' || substr(md5(random()::text), 1, 4),
    $1::int, 'scheduled', $2::text, 'GBP Main Audit', 'running'
  )
  RETURNING id, run_id, location_id
)
-- The location columns are carried through here because RETURNING can only see
-- the inserted row; the Code node needs the business name, verification state,
-- recipients and previous score in the same item.
SELECT
  ins.id                  AS run_db_id,
  ins.run_id,
  ins.location_id         AS location_db_id,
  l.location_id           AS location_slug,
  l.google_account_name,
  l.google_location_name,
  l.business_name,
  l.verification_state,
  COALESCE(NULLIF(TRIM(l.notify_emails), ''), 'kn0733@gmail.com') AS notify_emails,
  (SELECT overall_score FROM gbp_health_scores hs
     WHERE hs.location_id = l.id ORDER BY hs.scored_at DESC LIMIT 1) AS previous_score
FROM ins
JOIN gbp_locations l ON l.id = ins.location_id;"""

SQL_SAVE = """-- Single-parameter, injection-safe write of the whole audit result.
WITH payload AS (
  SELECT $1::jsonb AS p
),
ins_score AS (
  INSERT INTO gbp_health_scores (
    run_id, location_id, overall_score, grade,
    business_info_score, photos_score, reviews_score,
    profile_score, content_score, services_score,
    previous_score, score_delta
  )
  SELECT
    (p->'score'->>'run_id')::int,
    (p->'score'->>'location_id')::int,
    (p->'score'->>'overall_score')::numeric,
    (p->'score'->>'grade'),
    (p->'score'->>'business_info_score')::numeric,
    (p->'score'->>'photos_score')::numeric,
    (p->'score'->>'reviews_score')::numeric,
    (p->'score'->>'profile_score')::numeric,
    (p->'score'->>'content_score')::numeric,
    (p->'score'->>'services_score')::numeric,
    NULLIF(p->'score'->>'previous_score', 'null')::numeric,
    NULLIF(p->'score'->>'score_delta', 'null')::numeric
  FROM payload
  ON CONFLICT (run_id) DO UPDATE SET overall_score = EXCLUDED.overall_score
  RETURNING id, location_id
),
ins_dims AS (
  INSERT INTO gbp_dimension_scores (health_score_id, dimension_key, raw_score, weight_percent, weighted_score, checks)
  SELECT s.id, d->>'dimension_key', (d->>'raw_score')::numeric,
         (d->>'weight_percent')::numeric, (d->>'weighted_score')::numeric, d->'checks'
  FROM ins_score s, payload, jsonb_array_elements(p->'dimensions') d
  ON CONFLICT (health_score_id, dimension_key) DO UPDATE
    SET raw_score = EXCLUDED.raw_score,
        weighted_score = EXCLUDED.weighted_score,
        checks = EXCLUDED.checks
  RETURNING 1
),
ins_reco AS (
  INSERT INTO gbp_recommendations (
    recommendation_id, health_score_id, location_id, dimension_key, check_key,
    priority, title, detail, points_recoverable
  )
  SELECT
    'reco_' || s.id || '_' || (r->>'dimension_key') || '_' || (r->>'check_key'),
    s.id, s.location_id, r->>'dimension_key', r->>'check_key',
    r->>'priority', r->>'title', r->>'detail', (r->>'points_recoverable')::numeric
  FROM ins_score s, payload, jsonb_array_elements(p->'recommendations') r
  ON CONFLICT (recommendation_id) DO NOTHING
  RETURNING 1
),
-- ---------------------------------------------------------------------------
-- Media, services and performance are persisted to their own tables, not just
-- buried in raw_snapshot. Workflow 3 reads gbp_media and gbp_services to ground
-- the posts it writes, so these three CTEs are what make that grounding real.
-- ---------------------------------------------------------------------------
ins_media AS (
  INSERT INTO gbp_media (
    location_id, google_media_name, media_format, category,
    google_url, thumbnail_url, width_px, height_px,
    is_owner_uploaded, view_count, media_created_at, last_synced_at
  )
  SELECT
    s.location_id,
    m->>'google_media_name',
    NULLIF(m->>'media_format','null'),
    NULLIF(m->>'category','null'),
    NULLIF(m->>'google_url','null'),
    NULLIF(m->>'thumbnail_url','null'),
    NULLIF(m->>'width_px','null')::int,
    NULLIF(m->>'height_px','null')::int,
    COALESCE((m->>'is_owner_uploaded')::boolean, true),
    NULLIF(m->>'view_count','null')::int,
    NULLIF(m->>'media_created_at','null')::timestamp,
    now()
  FROM ins_score s, payload, jsonb_array_elements(p->'media') m
  WHERE m->>'google_media_name' IS NOT NULL
  ON CONFLICT (google_media_name) DO UPDATE SET
    category       = EXCLUDED.category,
    google_url     = EXCLUDED.google_url,
    thumbnail_url  = EXCLUDED.thumbnail_url,
    view_count     = COALESCE(EXCLUDED.view_count, gbp_media.view_count),
    last_synced_at = now(),
    redacted_at    = NULL,  -- re-synced content re-enters the retention window
    deleted_at     = NULL   -- a photo that reappeared is not deleted
  RETURNING 1
),
del_media AS (
  -- Photos removed from the profile are soft-deleted so the Photos dimension
  -- reflects reality. Skipped entirely when the media fetch failed.
  UPDATE gbp_media SET deleted_at = now()
  FROM ins_score s, payload
  WHERE gbp_media.location_id = s.location_id
    AND gbp_media.deleted_at IS NULL
    AND (p->>'media_ok')::boolean
    AND gbp_media.google_media_name NOT IN (
      SELECT m->>'google_media_name' FROM jsonb_array_elements(p->'media') m
    )
  RETURNING 1
),
ins_services AS (
  INSERT INTO gbp_services (
    location_id, service_key, display_name, description,
    price_amount_micros, price_currency, last_synced_at
  )
  SELECT
    s.location_id,
    sv->>'service_key',
    sv->>'display_name',
    NULLIF(sv->>'description','null'),
    NULLIF(sv->>'price_amount_micros','null')::bigint,
    NULLIF(sv->>'price_currency','null'),
    now()
  FROM ins_score s, payload, jsonb_array_elements(p->'services') sv
  WHERE sv->>'service_key' IS NOT NULL
  ON CONFLICT (location_id, service_key) DO UPDATE SET
    display_name        = EXCLUDED.display_name,
    description         = EXCLUDED.description,
    price_amount_micros = EXCLUDED.price_amount_micros,
    price_currency      = EXCLUDED.price_currency,
    last_synced_at      = now(),
    redacted_at         = NULL,
    deleted_at          = NULL
  RETURNING 1
),
del_services AS (
  UPDATE gbp_services SET deleted_at = now()
  FROM ins_score s, payload
  WHERE gbp_services.location_id = s.location_id
    AND gbp_services.deleted_at IS NULL
    AND (p->>'services_ok')::boolean
    AND gbp_services.service_key NOT IN (
      SELECT sv->>'service_key' FROM jsonb_array_elements(p->'services') sv
    )
  RETURNING 1
),
ins_perf AS (
  INSERT INTO gbp_performance_metrics (
    location_id, metric_date,
    business_impressions_desktop_maps, business_impressions_desktop_search,
    business_impressions_mobile_maps,  business_impressions_mobile_search,
    business_conversations, business_direction_requests,
    call_clicks, website_clicks, business_bookings, captured_at
  )
  SELECT
    s.location_id,
    (m->>'metric_date')::date,
    COALESCE((m->>'business_impressions_desktop_maps')::int, 0),
    COALESCE((m->>'business_impressions_desktop_search')::int, 0),
    COALESCE((m->>'business_impressions_mobile_maps')::int, 0),
    COALESCE((m->>'business_impressions_mobile_search')::int, 0),
    COALESCE((m->>'business_conversations')::int, 0),
    COALESCE((m->>'business_direction_requests')::int, 0),
    COALESCE((m->>'call_clicks')::int, 0),
    COALESCE((m->>'website_clicks')::int, 0),
    COALESCE((m->>'business_bookings')::int, 0),
    now()
  FROM ins_score s, payload, jsonb_array_elements(p->'performance') m
  ON CONFLICT (location_id, metric_date) DO UPDATE SET
    business_impressions_desktop_maps   = EXCLUDED.business_impressions_desktop_maps,
    business_impressions_desktop_search = EXCLUDED.business_impressions_desktop_search,
    business_impressions_mobile_maps    = EXCLUDED.business_impressions_mobile_maps,
    business_impressions_mobile_search  = EXCLUDED.business_impressions_mobile_search,
    business_conversations              = EXCLUDED.business_conversations,
    business_direction_requests         = EXCLUDED.business_direction_requests,
    call_clicks                         = EXCLUDED.call_clicks,
    website_clicks                      = EXCLUDED.website_clicks,
    business_bookings                   = EXCLUDED.business_bookings,
    captured_at                         = now()
  RETURNING 1
),
ins_stats AS (
  INSERT INTO gbp_review_stats (
    location_id, run_id, total_reviews, average_rating,
    count_5_star, count_4_star, count_3_star, count_2_star, count_1_star,
    reviews_with_reply, response_rate, median_response_hours,
    reviews_last_30_days, unanswered_count
  )
  SELECT
    s.location_id, (p->'score'->>'run_id')::int,
    (p->'review_stats'->>'total_reviews')::int,
    NULLIF(p->'review_stats'->>'average_rating','null')::numeric,
    (p->'review_stats'->>'count_5_star')::int,
    (p->'review_stats'->>'count_4_star')::int,
    (p->'review_stats'->>'count_3_star')::int,
    (p->'review_stats'->>'count_2_star')::int,
    (p->'review_stats'->>'count_1_star')::int,
    (p->'review_stats'->>'reviews_with_reply')::int,
    NULLIF(p->'review_stats'->>'response_rate','null')::numeric,
    NULLIF(p->'review_stats'->>'median_response_hours','null')::numeric,
    (p->'review_stats'->>'reviews_last_30_days')::int,
    (p->'review_stats'->>'unanswered_count')::int
  FROM ins_score s, payload
  RETURNING 1
)
SELECT id AS health_score_id FROM ins_score;"""

SQL_FINISH = """UPDATE gbp_audit_runs
SET status = $2::text,
    finished_at = now(),
    duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000,
    api_calls_made = $3::int,
    raw_snapshot = $4::jsonb
WHERE id = $1::int;

UPDATE gbp_locations SET last_audited_at = now() WHERE id = (
  SELECT location_id FROM gbp_audit_runs WHERE id = $1::int
);

UPDATE gbp_health_scores SET ai_summary = $5::text WHERE run_id = $1::int;"""

SQL_RECENT_POSTS = """SELECT status, published_at, topic_type, media_url, cta_type
FROM gbp_posts
WHERE location_id = $1::int
  AND deleted_at IS NULL
  AND published_at > now() - INTERVAL '120 days';"""

READ_MASK = ",".join([
    "name", "title", "storefrontAddress", "websiteUri", "phoneNumbers",
    "categories", "regularHours", "specialHours", "profile", "openInfo",
    "serviceItems", "labels", "storeCode", "latlng", "metadata", "serviceArea",
])


def node(name, ntype, ver, pos, params, creds=None, on_error=None, notes=None,
         always_output=False):
    n = {
        "parameters": params,
        "id": name.lower().replace(" ", "-"),
        "name": name,
        "type": ntype,
        "typeVersion": ver,
        "position": pos,
    }
    if creds:
        n["credentials"] = creds
    if on_error:
        n["onError"] = on_error
        n["retryOnFail"] = False
    if notes:
        n["notes"] = notes
        n["notesInFlow"] = True
    if always_output:
        # A query that legitimately returns no rows must not stop the chain.
        n["alwaysOutputData"] = True
    return n


nodes = [
    node("Weekly Schedule", "n8n-nodes-base.scheduleTrigger", 1.3, [-220, 300], {
        "rule": {"interval": [{"field": "weeks", "triggerAtDay": [1], "triggerAtHour": 9, "triggerAtMinute": 0}]}
    }, notes="Every Monday 09:00"),

    node("Get Locations To Audit", "n8n-nodes-base.postgres", 2.7, [0, 300], {
        "operation": "executeQuery",
        "query": SQL_GET_LOCATIONS,
        "options": {},
    }, {"postgres": CRED_PG}, notes="One item per active location"),

    node("Start Audit Run", "n8n-nodes-base.postgres", 2.7, [220, 300], {
        "operation": "executeQuery",
        "query": SQL_START_RUN,
        "options": {"queryReplacement": "={{ [ $json.location_db_id, $execution.id ] }}"},
    }, {"postgres": CRED_PG}, notes="Opens the run row, returns run_db_id"),

    node("Get Recent Posts", "n8n-nodes-base.postgres", 2.7, [440, 300], {
        "operation": "executeQuery",
        "query": SQL_RECENT_POSTS,
        "options": {"queryReplacement": "={{ [ $json.location_db_id ] }}"},
    }, {"postgres": CRED_PG}, notes="Feeds the Content dimension",
       always_output=True),

    node("Fetch Location Details", "n8n-nodes-base.httpRequest", 4.5, [660, 300], {
        "url": "=https://mybusinessbusinessinformation.googleapis.com/v1/{{ $('Start Audit Run').first().json.google_location_name || $('Get Locations To Audit').first().json.google_location_name }}",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "googleOAuth2Api",
        "sendQuery": True,
        "specifyQuery": "keypair",
        "queryParameters": {"parameters": [{"name": "readMask", "value": READ_MASK}]},
        "options": {"response": {"response": {"neverError": True}}, "timeout": 30000},
    }, {"googleOAuth2Api": CRED_GOOGLE}, on_error="continueRegularOutput",
       notes="Business Information API v1 — needs quota > 0"),

    node("Fetch Attributes", "n8n-nodes-base.httpRequest", 4.5, [880, 300], {
        "url": "=https://mybusinessbusinessinformation.googleapis.com/v1/{{ $('Get Locations To Audit').first().json.google_location_name }}/attributes",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "googleOAuth2Api",
        "options": {"response": {"response": {"neverError": True}}, "timeout": 30000},
    }, {"googleOAuth2Api": CRED_GOOGLE}, on_error="continueRegularOutput",
       notes="Attributes are NOT on the Location resource — they need this separate endpoint. Feeds the Profile dimension."),

    node("Fetch Media", "n8n-nodes-base.httpRequest", 4.5, [1100, 300], {
        "url": "=https://mybusiness.googleapis.com/v4/{{ $('Get Locations To Audit').first().json.google_account_name }}/{{ $('Get Locations To Audit').first().json.google_location_name }}/media",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "googleOAuth2Api",
        "sendQuery": True,
        "specifyQuery": "keypair",
        "queryParameters": {"parameters": [{"name": "pageSize", "value": "100"}]},
        "options": {
            "response": {"response": {"neverError": True}},
            "timeout": 30000,
            "pagination": {"pagination": {
                "paginationMode": "updateAParameterInEachRequest",
                "parameters": {"parameters": [
                    {"type": "qs", "name": "pageToken",
                     "value": "={{ $response.body.nextPageToken }}"}]},
                "paginationCompleteWhen": "other",
                "completeExpression": "={{ !$response.body.nextPageToken }}",
                "limitPagesFetched": True,
                "maxRequests": 20,
                "requestInterval": 300,
            }},
        },
    }, {"googleOAuth2Api": CRED_GOOGLE}, on_error="continueRegularOutput",
       notes="v4 — 403 until allowlisted. Paginated; failure downgrades the run to 'partial'."),

    node("Fetch Reviews", "n8n-nodes-base.httpRequest", 4.5, [1320, 300], {
        "url": "=https://mybusiness.googleapis.com/v4/{{ $('Get Locations To Audit').first().json.google_account_name }}/{{ $('Get Locations To Audit').first().json.google_location_name }}/reviews",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "googleOAuth2Api",
        "sendQuery": True,
        "specifyQuery": "keypair",
        "queryParameters": {"parameters": [{"name": "pageSize", "value": "50"}]},
        "options": {
            "response": {"response": {"neverError": True}},
            "timeout": 30000,
            "pagination": {"pagination": {
                "paginationMode": "updateAParameterInEachRequest",
                "parameters": {"parameters": [
                    {"type": "qs", "name": "pageToken",
                     "value": "={{ $response.body.nextPageToken }}"}]},
                "paginationCompleteWhen": "other",
                "completeExpression": "={{ !$response.body.nextPageToken }}",
                "limitPagesFetched": True,
                "maxRequests": 20,
                "requestInterval": 300,
            }},
        },
    }, {"googleOAuth2Api": CRED_GOOGLE}, on_error="continueRegularOutput",
       notes="v4 — 403 until allowlisted. Paginated so the reply rate covers every review, not just page 1."),

    node("Fetch Performance", "n8n-nodes-base.httpRequest", 4.5, [1540, 300], {
        "url": "=https://businessprofileperformance.googleapis.com/v1/{{ $('Get Locations To Audit').first().json.google_location_name }}:fetchMultiDailyMetricsTimeSeries",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "googleOAuth2Api",
        "sendQuery": True,
        "specifyQuery": "keypair",
        "queryParameters": {"parameters": [
            {"name": "dailyMetrics", "value": "BUSINESS_IMPRESSIONS_DESKTOP_MAPS"},
            {"name": "dailyMetrics", "value": "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH"},
            {"name": "dailyMetrics", "value": "BUSINESS_IMPRESSIONS_MOBILE_MAPS"},
            {"name": "dailyMetrics", "value": "BUSINESS_IMPRESSIONS_MOBILE_SEARCH"},
            {"name": "dailyMetrics", "value": "BUSINESS_CONVERSATIONS"},
            {"name": "dailyMetrics", "value": "BUSINESS_DIRECTION_REQUESTS"},
            {"name": "dailyMetrics", "value": "CALL_CLICKS"},
            {"name": "dailyMetrics", "value": "WEBSITE_CLICKS"},
            {"name": "dailyMetrics", "value": "BUSINESS_BOOKINGS"},
            {"name": "dailyRange.start_date.year", "value": "={{ $now.minus(30, 'days').year }}"},
            {"name": "dailyRange.start_date.month", "value": "={{ $now.minus(30, 'days').month }}"},
            {"name": "dailyRange.start_date.day", "value": "={{ $now.minus(30, 'days').day }}"},
            {"name": "dailyRange.end_date.year", "value": "={{ $now.year }}"},
            {"name": "dailyRange.end_date.month", "value": "={{ $now.month }}"},
            {"name": "dailyRange.end_date.day", "value": "={{ $now.day }}"},
        ]},
        "options": {"queryParameterArrays": "repeat",
                    "response": {"response": {"neverError": True}}, "timeout": 30000},
    }, {"googleOAuth2Api": CRED_GOOGLE}, on_error="continueRegularOutput",
       notes="Performance API v1 — enabled, no allowlist needed"),

    node("Calculate Health Score", "n8n-nodes-base.code", 2, [1760, 300], {
        "mode": "runOnceForAllItems",
        "language": "javaScript",
        "jsCode": ASSEMBLE,
    }, notes="Weighted 25/20/20/15/10/10 scoring engine"),

    node("Save Audit Results", "n8n-nodes-base.postgres", 2.7, [1980, 300], {
        "operation": "executeQuery",
        "query": SQL_SAVE,
        "options": {"queryReplacement": "={{ [ JSON.stringify($json.payload) ] }}",
                    "queryBatching": "transaction"},
    }, {"postgres": CRED_PG},
       notes="One parameterised jsonb write: score + dimensions + recommendations + review stats"),

    node("Claude Summary", "n8n-nodes-base.httpRequest", 4.5, [2200, 300], {
        "method": "POST",
        "url": "https://api.anthropic.com/v1/messages",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendHeaders": True,
        "specifyHeaders": "keypair",
        "headerParameters": {"parameters": [
            {"name": "anthropic-version", "value": "2023-06-01"},
            {"name": "content-type", "value": "application/json"},
        ]},
        "sendBody": True,
        "contentType": "json",
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 900, system: 'You are a local SEO analyst. Be specific and concise. No preamble, no bullet symbols, at most 150 words.', messages: [{ role: 'user', content: 'Here is a Google Business Profile audit for ' + $('Calculate Health Score').first().json.business_name + '. Explain in plain language what is holding the score back and what to do first.\\n\\n' + JSON.stringify($('Calculate Health Score').first().json.score) }] }) }}",
        "options": {"response": {"response": {"neverError": True}}, "timeout": 60000},
    }, {"httpHeaderAuth": CRED_ANTHROPIC}, on_error="continueRegularOutput",
       notes="Anthropic messages API. Credential: Header Auth 'x-api-key'."),

    node("Build Email", "n8n-nodes-base.code", 2, [2420, 300], {
        "mode": "runOnceForAllItems",
        "language": "javaScript",
        "jsCode": EMAIL_CODE,
    }),

    node("Finish Audit Run", "n8n-nodes-base.postgres", 2.7, [2640, 300], {
        "operation": "executeQuery",
        "query": SQL_FINISH,
        "options": {"queryReplacement": "={{ [ $('Calculate Health Score').first().json.run_db_id, $('Calculate Health Score').first().json.status, $('Calculate Health Score').first().json.api_calls_made, JSON.stringify($('Calculate Health Score').first().json.raw_snapshot), $json.ai_summary || '' ] }}"},
    }, {"postgres": CRED_PG}, notes="Closes the run, stamps last_audited_at, saves the AI summary"),

    node("Email Report", "n8n-nodes-base.gmail", 2.2, [2860, 300], {
        "resource": "message",
        "operation": "send",
        "sendTo": "={{ $('Build Email').first().json.to }}",
        "subject": "={{ $('Build Email').first().json.subject }}",
        "emailType": "html",
        "message": "={{ $('Build Email').first().json.html }}",
        "options": {"appendAttribution": False},
    }, {"gmailOAuth2": CRED_GMAIL}),
]

order = [n["name"] for n in nodes]
connections = {}
for a, b in zip(order, order[1:]):
    connections[a] = {"main": [[{"node": b, "type": "main", "index": 0}]]}

# ---------------------------------------------------------------------------
# Pinned sample data so the workflow is runnable before Google approves access
# ---------------------------------------------------------------------------
def days_ago_iso(n):
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) - timedelta(days=n)).isoformat().replace("+00:00", "Z")

pin_location = {
    "name": "locations/1234567890123456789",
    "title": "Negotrip",
    "storefrontAddress": {"addressLines": ["Plot 12, Sahid Nagar"], "locality": "Bhubaneswar",
                          "administrativeArea": "Odisha", "postalCode": "751007", "regionCode": "IN"},
    "websiteUri": "https://negotrip.in",
    "phoneNumbers": {"primaryPhone": "+91 90000 00000"},
    "categories": {"primaryCategory": {"displayName": "Travel agency", "name": "gcid:travel_agency"},
                   "additionalCategories": [{"displayName": "Tour operator"}]},
    "regularHours": {"periods": [{"openDay": d, "openTime": {"hours": 9}, "closeDay": d,
                                  "closeTime": {"hours": 20}} for d in
                                 ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"]]},
    "profile": {"description": "Negotrip plans custom Odisha itineraries, airport transfers and temple tours. " * 2},
    "openInfo": {"status": "OPEN", "openingDate": {"year": 2019, "month": 4, "day": 1}},
    "labels": [], "storeCode": "",
    "latlng": {"latitude": 20.2961, "longitude": 85.8245},
    "serviceItems": [
        {"freeFormServiceItem": {"label": {"displayName": "Airport transfer", "description": "Short"}}},
        {"freeFormServiceItem": {"label": {"displayName": "Puri day tour",
                                           "description": "A full day covering Jagannath Temple, the beach and Konark on the way back."}},
         "price": {"currencyCode": "INR", "units": "2500"}},
    ],
    "metadata": {"canDelete": False, "placeId": "ChIJexample"},
}

pin_media = {"mediaItems": [
    {"name": "accounts/106/locations/123/media/logo1", "mediaFormat": "PHOTO",
     "locationAssociation": {"category": "LOGO"}, "createTime": days_ago_iso(200),
     "googleUrl": "https://example.com/logo.jpg"},
] + [
    {"name": f"accounts/106/locations/123/media/ext{i}", "mediaFormat": "PHOTO",
     "locationAssociation": {"category": "EXTERIOR"}, "createTime": days_ago_iso(150 + i),
     "googleUrl": f"https://example.com/ext{i}.jpg"} for i in range(5)
]}

pin_reviews = {
    "reviews": [
        {"name": "accounts/106/locations/123/reviews/r1", "reviewer": {"displayName": "A. Traveller"},
         "starRating": "TWO", "comment": "Pickup was late and nobody answered the phone.",
         "createTime": days_ago_iso(2), "updateTime": days_ago_iso(2)},
        {"name": "accounts/106/locations/123/reviews/r2", "reviewer": {"displayName": "R. Mishra"},
         "starRating": "FIVE", "comment": "Excellent Puri tour, driver was punctual.",
         "createTime": days_ago_iso(9), "updateTime": days_ago_iso(9),
         "reviewReply": {"comment": "Thank you!", "updateTime": days_ago_iso(7)}},
        {"name": "accounts/106/locations/123/reviews/r3", "reviewer": {"displayName": "S. Das"},
         "starRating": "FOUR", "comment": "Good value.", "createTime": days_ago_iso(40),
         "updateTime": days_ago_iso(40),
         "reviewReply": {"comment": "Thanks for travelling with us.", "updateTime": days_ago_iso(38)}},
    ],
    "averageRating": 4.3,
    "totalReviewCount": 28,
}

def _perf_series(metric, values):
    from datetime import date, timedelta
    base = date(2026, 9, 1)
    return {"dailyMetric": metric, "timeSeries": {"datedValues": [
        {"date": {"year": (base + timedelta(days=i)).year,
                  "month": (base + timedelta(days=i)).month,
                  "day": (base + timedelta(days=i)).day},
         "value": str(v)} for i, v in enumerate(values)]}}

pin_performance = {"multiDailyMetricTimeSeries": [{"dailyMetricTimeSeries": [
    _perf_series("BUSINESS_IMPRESSIONS_MOBILE_SEARCH", [412, 388, 455]),
    _perf_series("BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", [88, 71, 96]),
    _perf_series("CALL_CLICKS", [17, 12, 21]),
    _perf_series("WEBSITE_CLICKS", [34, 29, 41]),
    _perf_series("BUSINESS_DIRECTION_REQUESTS", [21, 18, 25]),
]}]}

pin_attributes = {"name": "locations/1234567890123456789/attributes", "attributes": [
    {"name": "attributes/has_wheelchair_accessible_entrance", "valueType": "BOOL", "values": [True]},
    {"name": "attributes/pay_credit_card", "valueType": "BOOL", "values": [True]},
    {"name": "attributes/url_appointment", "valueType": "URL",
     "uriValues": [{"uri": "https://negotrip.in/book"}]},
    {"name": "attributes/service_option_online_appointments", "valueType": "BOOL", "values": [True]},
]}

pin_data = {
    "Fetch Location Details": [{"json": pin_location}],
    "Fetch Attributes": [{"json": pin_attributes}],
    "Fetch Media": [{"json": pin_media}],
    "Fetch Reviews": [{"json": pin_reviews}],
    "Fetch Performance": [{"json": pin_performance}],
}

workflow = {
    "name": "GBP Main Audit",
    "nodes": nodes,
    "connections": connections,
    "pinData": pin_data,
    "settings": {"executionOrder": "v1", "saveManualExecutions": True,
                 "callerPolicy": "workflowsFromSameOwner"},
    "meta": {"instanceId": "gbp-automation"},
    "tags": [],
}

out = pathlib.Path("workflows/GBP_Main_Audit.json")
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(workflow, indent=2))
print(f"Wrote {out}  ({out.stat().st_size:,} bytes, {len(nodes)} nodes)")
