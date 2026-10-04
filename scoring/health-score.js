/**
 * GBP Health Scoring Engine
 * -------------------------------------------------------------------------
 * Pure function, no dependencies — paste the body of this file into an n8n
 * Code node, or require it if you run n8n with NODE_FUNCTION_ALLOW_EXTERNAL.
 *
 * Weighted dimensions (must total 100):
 *   business_info  25   photos   20   reviews  20
 *   profile        15   content  10   services 10
 *
 * Every dimension scores 0-100 on its own, then contributes
 * raw_score * (weight / 100) to the overall score.
 *
 * Grades: A >=85, B >=70, C >=55, D >=40, F <40
 * -------------------------------------------------------------------------
 */

const WEIGHTS = {
  business_info: 25,
  photos: 20,
  reviews: 20,
  profile: 15,
  content: 10,
  services: 10,
};

const REQUIRED_PHOTO_CATEGORIES = [
  { key: 'LOGO', need: 1, match: ['LOGO', 'PROFILE'] },
  { key: 'COVER', need: 1, match: ['COVER'] },
  { key: 'EXTERIOR', need: 3, match: ['EXTERIOR'] },
  { key: 'INTERIOR', need: 3, match: ['INTERIOR'] },
];

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

/** Clamp n into [lo, hi]. */
function clamp(n, lo, hi) {
  if (Number.isNaN(n) || n === null || n === undefined) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** Award points proportionally: value/target of max, capped at max. */
function scale(value, target, max) {
  if (!target) return 0;
  return round2(clamp((Number(value) || 0) / target, 0, 1) * max);
}

/** Award full points above `best`, zero below `worst`, linear between. */
function band(value, best, worst, max) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  if (best === worst) return v >= best ? max : 0;
  const ratio = (v - worst) / (best - worst);
  return round2(clamp(ratio, 0, 1) * max);
}

/** Inverse band: full points when value is small (e.g. days since last post). */
function bandInverse(value, best, worst, max) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 0;
  if (best === worst) return v <= best ? max : 0;
  const ratio = (worst - v) / (worst - best);
  return round2(clamp(ratio, 0, 1) * max);
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function daysBetween(from, to) {
  if (!from) return null;
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (b - a) / 86400000;
}

function nonEmpty(v) {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return String(v).trim().length > 0;
}

/** Build one check result. */
function check(key, label, points, maxPoints, detail) {
  const p = round2(clamp(points, 0, maxPoints));
  return {
    key,
    label,
    points: p,
    max_points: maxPoints,
    passed: p >= maxPoints,
    detail: detail || null,
  };
}

// --------------------------------------------------------------------------
// Dimension 1 — Business Information (25%)
// --------------------------------------------------------------------------
function scoreBusinessInfo(loc) {
  const checks = [];
  const hours = loc.regularHours && loc.regularHours.periods ? loc.regularHours.periods : [];
  const daysCovered = new Set(hours.map((p) => p.openDay)).size;
  const desc = (loc.profile && loc.profile.description) || '';

  checks.push(check('name', 'Business name set',
    nonEmpty(loc.title) ? 5 : 0, 5, loc.title || 'missing'));

  checks.push(check('primary_category', 'Primary category set',
    nonEmpty(loc.categories && loc.categories.primaryCategory) ? 15 : 0, 15,
    (loc.categories && loc.categories.primaryCategory
      && loc.categories.primaryCategory.displayName) || 'missing'));

  const addl = (loc.categories && loc.categories.additionalCategories) || [];
  checks.push(check('additional_categories', 'At least 2 additional categories',
    scale(addl.length, 2, 5), 5, `${addl.length} set`));

  const addr = loc.storefrontAddress || {};
  const addrComplete = nonEmpty(addr.addressLines) && nonEmpty(addr.locality)
    && nonEmpty(addr.postalCode) && nonEmpty(addr.regionCode);
  checks.push(check('address', 'Complete storefront address',
    addrComplete ? 15 : (nonEmpty(addr.addressLines) ? 7 : 0), 15,
    addrComplete ? 'complete' : 'incomplete or service-area only'));

  const phones = (loc.phoneNumbers && loc.phoneNumbers.primaryPhone) || null;
  checks.push(check('phone', 'Primary phone number',
    nonEmpty(phones) ? 10 : 0, 10, phones || 'missing'));

  checks.push(check('website', 'Website URL',
    nonEmpty(loc.websiteUri) ? 10 : 0, 10, loc.websiteUri || 'missing'));

  checks.push(check('hours', 'Opening hours for all 7 days',
    scale(daysCovered, 7, 20), 20, `${daysCovered}/7 days set`));

  const special = (loc.specialHours && loc.specialHours.specialHourPeriods) || [];
  checks.push(check('special_hours', 'Upcoming holiday hours set',
    special.length > 0 ? 5 : 0, 5, `${special.length} periods`));

  checks.push(check('description', 'Description of at least 250 characters',
    scale(desc.length, 250, 10), 10, `${desc.length} characters`));

  checks.push(check('opening_date', 'Opening date set',
    loc.openInfo && loc.openInfo.openingDate ? 5 : 0, 5,
    loc.openInfo && loc.openInfo.openingDate ? 'set' : 'missing'));

  return finalise(checks);
}

// --------------------------------------------------------------------------
// Dimension 2 — Photos (20%)
// --------------------------------------------------------------------------
function scorePhotos(media, now) {
  const owned = (media || []).filter((m) => m.is_owner_uploaded !== false && !m.deleted_at);
  const checks = [];
  const byCategory = {};
  owned.forEach((m) => {
    const c = (m.category || 'ADDITIONAL').toUpperCase();
    byCategory[c] = (byCategory[c] || 0) + 1;
  });

  checks.push(check('photo_count', 'At least 20 owner photos',
    scale(owned.length, 20, 30), 30, `${owned.length} photos`));

  REQUIRED_PHOTO_CATEGORIES.forEach((spec) => {
    const need = spec.need;
    const have = spec.match.reduce((n, c) => n + (byCategory[c] || 0), 0);
    const name = spec.key.toLowerCase();
    checks.push(check(
      `photo_${name}`,
      `${need > 1 ? 'At least 3 ' : ''}${name} photo${need > 1 ? 's' : ''}`,
      scale(have, need, 10), 10, `${have}/${need}`
    ));
  });

  const newest = owned
    .map((m) => m.media_created_at)
    .filter(Boolean)
    .sort()
    .pop();
  const ageDays = newest ? daysBetween(newest, now) : null;
  checks.push(check('photo_recency', 'A photo added in the last 30 days',
    ageDays === null ? 0 : bandInverse(ageDays, 30, 180, 20), 20,
    ageDays === null ? 'no dated photos' : `${Math.round(ageDays)} days since newest`));

  checks.push(check('photo_variety', 'Photos across at least 5 categories',
    scale(Object.keys(byCategory).length, 5, 10), 10,
    `${Object.keys(byCategory).length} categories`));

  return finalise(checks);
}

// --------------------------------------------------------------------------
// Dimension 3 — Reviews (20%)
// --------------------------------------------------------------------------
function scoreReviews(stats) {
  const s = stats || {};
  const checks = [];
  const total = Number(s.total_reviews) || 0;

  checks.push(check('review_count', 'At least 50 reviews',
    scale(total, 50, 25), 25, `${total} reviews`));

  // 4.7+ earns full marks; 3.0 or below earns none.
  checks.push(check('average_rating', 'Average rating of 4.7 or better',
    total === 0 ? 0 : band(s.average_rating, 4.7, 3.0, 30), 30,
    total === 0 ? 'no reviews yet' : `${s.average_rating} stars`));

  const rate = Number(s.response_rate);
  checks.push(check('response_rate', 'Reply to every review',
    total === 0 ? 0 : scale(rate, 100, 35), 35,
    total === 0 ? 'no reviews yet' : `${rate}% answered`));

  checks.push(check('response_speed', 'Median reply within 48 hours',
    s.median_response_hours === null || s.median_response_hours === undefined
      ? 0
      : bandInverse(s.median_response_hours, 48, 336, 10), 10,
    s.median_response_hours === null || s.median_response_hours === undefined
      ? 'no replies yet'
      : `${s.median_response_hours}h median`));

  return finalise(checks);
}

// --------------------------------------------------------------------------
// Dimension 4 — Profile Completeness (15%)
// --------------------------------------------------------------------------
function scoreProfile(loc) {
  const checks = [];
  const attrs = loc.attributes || [];
  const filled = attrs.filter((a) =>
    (a.values && a.values.length) ||
    (a.repeatedEnumValue && a.repeatedEnumValue.setValues && a.repeatedEnumValue.setValues.length) ||
    a.uriValues && a.uriValues.length
  );

  checks.push(check('attributes', 'At least 10 attributes populated',
    scale(filled.length, 10, 35), 35,
    `${filled.length} populated, target 10 (${attrs.length} returned by the API)`));

  const verified = (loc.verification_state || loc.verificationState || '').toLowerCase() === 'verified';
  checks.push(check('verified', 'Location is verified',
    verified ? 25 : 0, 25, verified ? 'verified' : 'not verified'));

  const links = (loc.placeActionLinks || []).length;
  checks.push(check('place_actions', 'Booking or ordering action links',
    scale(links, 1, 15), 15, `${links} links`));

  checks.push(check('labels', 'Store code or labels set for reporting',
    nonEmpty(loc.storeCode) || nonEmpty(loc.labels) ? 10 : 0, 10,
    nonEmpty(loc.storeCode) ? loc.storeCode : 'missing'));

  checks.push(check('service_area', 'Service area or precise map pin set',
    (loc.serviceArea && loc.serviceArea.places) || loc.latlng ? 15 : 0, 15,
    loc.latlng ? 'map pin set' : 'missing'));

  return finalise(checks);
}

// --------------------------------------------------------------------------
// Dimension 5 — Content (10%)
// --------------------------------------------------------------------------
function scoreContent(posts, now) {
  const published = (posts || []).filter((p) => p.status === 'published' && p.published_at);
  const checks = [];

  const last30 = published.filter((p) => daysBetween(p.published_at, now) <= 30);
  checks.push(check('post_frequency', 'At least 4 posts in the last 30 days',
    scale(last30.length, 4, 40), 40, `${last30.length} posts in 30 days`));

  const newest = published.map((p) => p.published_at).sort().pop();
  const ageDays = newest ? daysBetween(newest, now) : null;
  checks.push(check('post_recency', 'Posted within the last 7 days',
    ageDays === null ? 0 : bandInverse(ageDays, 7, 60, 30), 30,
    ageDays === null ? 'never posted' : `${Math.round(ageDays)} days since last post`));

  const types = new Set(published.map((p) => p.topic_type));
  checks.push(check('post_variety', 'Uses at least 2 post types',
    scale(types.size, 2, 15), 15, `${types.size} types used`));

  const withMedia = last30.filter((p) => nonEmpty(p.media_url) && nonEmpty(p.cta_type));
  checks.push(check('post_quality', 'Recent posts carry an image and a call to action',
    last30.length === 0 ? 0 : scale(withMedia.length / last30.length, 1, 15), 15,
    last30.length === 0 ? 'no recent posts' : `${withMedia.length}/${last30.length} complete`));

  return finalise(checks);
}

// --------------------------------------------------------------------------
// Dimension 6 — Services (10%)
// --------------------------------------------------------------------------
function scoreServices(services) {
  const list = (services || []).filter((s) => !s.deleted_at);
  const checks = [];

  checks.push(check('service_count', 'At least 5 services listed',
    scale(list.length, 5, 40), 40, `${list.length} services`));

  const described = list.filter((s) => (s.description || '').trim().length >= 50);
  checks.push(check('service_descriptions', 'Every service has a 50+ character description',
    list.length === 0 ? 0 : scale(described.length / list.length, 1, 40), 40,
    list.length === 0 ? 'none listed' : `${described.length}/${list.length} described`));

  const priced = list.filter((s) => s.price_amount_micros !== null && s.price_amount_micros !== undefined);
  checks.push(check('service_pricing', 'Services show a price',
    list.length === 0 ? 0 : scale(priced.length / list.length, 1, 20), 20,
    list.length === 0 ? 'none listed' : `${priced.length}/${list.length} priced`));

  return finalise(checks);
}

// --------------------------------------------------------------------------
// Assembly
// --------------------------------------------------------------------------
function finalise(checks) {
  const earned = checks.reduce((sum, c) => sum + c.points, 0);
  const possible = checks.reduce((sum, c) => sum + c.max_points, 0);
  // Each dimension is normalised to 0-100 regardless of how its checks add up.
  const raw = possible === 0 ? 0 : round2((earned / possible) * 100);
  return { raw_score: raw, checks };
}

function gradeFor(score) {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function priorityFor(pointsRecoverable) {
  if (pointsRecoverable >= 5) return 'critical';
  if (pointsRecoverable >= 3) return 'high';
  if (pointsRecoverable >= 1.5) return 'medium';
  return 'low';
}

/**
 * Score one location.
 *
 * @param {object} input
 * @param {object} input.location     Business Information API location resource
 * @param {Array}  input.media        rows from gbp_media
 * @param {object} input.reviewStats  row from gbp_review_stats
 * @param {Array}  input.posts        rows from gbp_posts
 * @param {Array}  input.services     rows from gbp_services
 * @param {string} [input.now]        ISO timestamp, defaults to current time
 * @param {number} [input.previousScore]
 * @returns {object} overall score, grade, dimension breakdown, recommendations
 */
function scoreLocation(input) {
  const now = input.now || new Date().toISOString();
  const loc = input.location || {};

  const results = {
    business_info: scoreBusinessInfo(loc),
    photos: scorePhotos(input.media, now),
    reviews: scoreReviews(input.reviewStats),
    profile: scoreProfile(loc),
    content: scoreContent(input.posts, now),
    services: scoreServices(input.services),
  };

  const dimensions = Object.keys(WEIGHTS).map((key) => {
    const weight = WEIGHTS[key];
    const raw = results[key].raw_score;
    return {
      dimension_key: key,
      raw_score: raw,
      weight_percent: weight,
      weighted_score: round2(raw * (weight / 100)),
      checks: results[key].checks,
    };
  });

  const overall = round2(dimensions.reduce((sum, d) => sum + d.weighted_score, 0));

  // Every failed check becomes a recommendation, priced in overall-score points.
  const recommendations = [];
  dimensions.forEach((d) => {
    const possible = d.checks.reduce((s, c) => s + c.max_points, 0);
    d.checks.forEach((c) => {
      if (c.passed) return;
      const missing = c.max_points - c.points;
      const pointsRecoverable = possible === 0
        ? 0
        : round2((missing / possible) * 100 * (d.weight_percent / 100));
      recommendations.push({
        dimension_key: d.dimension_key,
        check_key: c.key,
        title: c.label,
        detail: c.detail,
        points_recoverable: pointsRecoverable,
        priority: priorityFor(pointsRecoverable),
      });
    });
  });
  recommendations.sort((a, b) => b.points_recoverable - a.points_recoverable);

  const previous = input.previousScore === undefined || input.previousScore === null
    ? null
    : Number(input.previousScore);

  return {
    overall_score: overall,
    grade: gradeFor(overall),
    previous_score: previous,
    score_delta: previous === null ? null : round2(overall - previous),
    scored_at: now,
    dimensions,
    // Flat fields for the denormalised columns on gbp_health_scores
    business_info_score: results.business_info.raw_score,
    photos_score: results.photos.raw_score,
    reviews_score: results.reviews.raw_score,
    profile_score: results.profile.raw_score,
    content_score: results.content.raw_score,
    services_score: results.services.raw_score,
    recommendations,
  };
}

module.exports = {
  scoreLocation,
  scoreBusinessInfo,
  scorePhotos,
  scoreReviews,
  scoreProfile,
  scoreContent,
  scoreServices,
  WEIGHTS,
  REQUIRED_PHOTO_CATEGORIES,
};
