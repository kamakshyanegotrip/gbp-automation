#!/usr/bin/env python3
"""Generate the GBP Review Response workflow JSON for n8n import."""
import json, pathlib
from datetime import datetime, timedelta, timezone

CRED_GOOGLE = {"id": "pMOKted8v0rROW9p", "name": "GBP Automation OAuth"}
CRED_PG     = {"id": "73038PPSx78LOwXp", "name": "GBP Postgres"}
CRED_GMAIL  = {"id": "kSrGTNfsbOFylPXx", "name": "Gmail - info@negotrip.com"}
CRED_ANTHROPIC = {"id": "B1UfRtUbk4dYzhuw", "name": "Anthropic API"}

# Never auto-send below this rating, whatever the model says.
MIN_AUTO_RATING = 4
# Cap Claude calls per run so a review backlog can't produce a surprise bill.
BATCH_LIMIT = 10

# ---------------------------------------------------------------------------
# Code: normalise the paginated v4 review payload into one item per review
# ---------------------------------------------------------------------------
NORMALISE = r"""
const loc = $('Get Locations').first().json;

function fetchPages(nodeName) {
  let items;
  try { items = $(nodeName).all().map((i) => i.json); }
  catch (e) { return { ok: false, pages: [] }; }
  const failed = items.some(
    (v) => !v || v.error !== undefined || (typeof v.code === 'number' && v.code >= 400)
  );
  return { ok: !failed, pages: items.filter((v) => v && v.error === undefined) };
}

const fetched = fetchPages('Fetch Reviews');
if (!fetched.ok) {
  throw new Error(
    'Reviews could not be fetched. The Google My Business v4 API returns 403 until the ' +
    'project allowlist is approved — check the quota page before debugging anything else.'
  );
}

const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const reviews = fetched.pages.reduce((acc, p) => acc.concat(p.reviews || []), []);

const rows = reviews.map((r) => {
  const rating = STAR[r.starRating] || Number(r.starRating) || 0;
  const replied = r.reviewReply ? r.reviewReply.updateTime : null;
  const latency = r.createTime && replied
    ? Math.round(((new Date(replied) - new Date(r.createTime)) / 3600000) * 100) / 100
    : null;
  return {
    location_id: loc.location_db_id,
    google_review_id: r.name,
    reviewer_display_name: (r.reviewer && r.reviewer.displayName) || null,
    is_anonymous: !!(r.reviewer && r.reviewer.isAnonymous),
    star_rating: rating,
    comment: r.comment || null,
    review_created_at: r.createTime || null,
    review_updated_at: r.updateTime || null,
    reply_comment: r.reviewReply ? r.reviewReply.comment : null,
    reply_updated_at: replied,
    reply_status: r.reviewReply ? 'sent' : 'none',
    reply_source: r.reviewReply ? 'imported' : null,
    response_latency_hours: latency,
  };
}).filter((r) => r.star_rating >= 1 && r.star_rating <= 5);

return [{ json: { location_id: loc.location_db_id, count: rows.length, rows } }];
"""

# ---------------------------------------------------------------------------
# Code: parse Claude's JSON reply safely and decide whether it may auto-send
# ---------------------------------------------------------------------------
PARSE_DRAFT = r"""
const review = $('Get Reply Queue').all()[$itemIndex].json;
const MIN_AUTO_RATING = %(min_rating)d;

// A human who edited the draft and set reply_status to 'pending' has approved
// that exact wording. Publish it verbatim — never let a fresh model draft
// silently replace text a person signed off on.
const humanApproved = review.reply_status === 'pending'
  && typeof review.ai_suggested_reply === 'string'
  && review.ai_suggested_reply.trim().length > 0;

// Claude is asked for JSON, but never trust that it complied.
let parsed = null;
let parseError = null;
try {
  const res = $input.item.json;
  const text = res && res.content && res.content[0] ? res.content[0].text : null;
  if (!text) throw new Error('Claude returned no content');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in the model output');
  parsed = JSON.parse(match[0]);
} catch (e) {
  parseError = e.message;
}

const modelReply = parsed && typeof parsed.reply === 'string' ? parsed.reply.trim() : null;
const reply = humanApproved ? review.ai_suggested_reply.trim() : modelReply;
const sentiment = parsed && ['positive', 'neutral', 'negative', 'mixed'].includes(parsed.sentiment)
  ? parsed.sentiment
  : null;
const modelWantsEscalation = !!(parsed && parsed.escalate);

const RED_FLAGS = /\b(lawyer|legal|sue|police|fraud|scam|refund|chargeback|injur|unsafe|accident|discriminat|harass|steal|stole|theft)\b/i;
const redFlagged = review.comment ? RED_FLAGS.test(review.comment) : false;

// --- guard rails ------------------------------------------------------------
// A reply is only ever sent automatically when EVERY condition holds. Any doubt
// routes the draft to a human instead. Replies are public and cannot be unsent.
const reasons = [];

// Technical limits apply to everything, human-approved or not.
if (!reply)                       reasons.push('no reply text produced');
if (reply && reply.length > 4000) reasons.push('reply exceeds Google 4096-character limit');

if (!humanApproved) {
  // Judgement-based holds. A person who has already approved the wording has
  // made these calls themselves, so they are skipped on that path — otherwise
  // a 1-star review could never be answered at all.
  if (parseError)                   reasons.push('model output could not be parsed: ' + parseError);
  if (reply && reply.length < 20)   reasons.push('reply suspiciously short');
  if (review.star_rating < MIN_AUTO_RATING) reasons.push('rating is ' + review.star_rating + ' — a human should answer');
  if (modelWantsEscalation)         reasons.push('model flagged this for escalation');
  if (sentiment === 'negative')     reasons.push('negative sentiment');
  if (!review.auto_reply_enabled)   reasons.push('auto-reply is switched off for this location');
  if (redFlagged)                   reasons.push('review mentions a legal, safety or refund issue');
}

const requiresEscalation = review.star_rating <= 2 || modelWantsEscalation || redFlagged;
const canAutoSend = reasons.length === 0;

return {
  json: {
    review_db_id: review.id,
    google_review_id: review.google_review_id,
    location_id: review.location_id,
    business_name: review.business_name,
    reviewer: review.reviewer_display_name,
    star_rating: review.star_rating,
    comment: review.comment,
    hours_waiting: review.hours_waiting,
    reply,
    sentiment,
    requires_escalation: requiresEscalation,
    escalation_reason: requiresEscalation ? reasons.join('; ') : null,
    can_auto_send: canAutoSend,
    human_approved: humanApproved,
    generated_by: humanApproved ? 'human' : 'automation',
    hold_reasons: reasons,
    reply_status: canAutoSend ? 'pending' : 'awaiting_approval',
    model_used: humanApproved ? null : ((($input.item.json || {}).model) || 'claude-sonnet-4-5'),
    input_tokens: ((($input.item.json || {}).usage) || {}).input_tokens || null,
    output_tokens: ((($input.item.json || {}).usage) || {}).output_tokens || null,
  },
};
""" % {"min_rating": MIN_AUTO_RATING}

# ---------------------------------------------------------------------------
# Code: digest email
# ---------------------------------------------------------------------------
DIGEST = r"""
const items = $input.all().map((i) => i.json);
const loc = $('Get Locations').first().json;

const sent      = items.filter((i) => i.send_outcome === 'sent');
const failed    = items.filter((i) => i.send_outcome === 'failed');
const held      = items.filter((i) => !i.can_auto_send);
const escalated = held.filter((i) => i.requires_escalation);

function card(i, showReply) {
  const stars = '★'.repeat(i.star_rating) + '☆'.repeat(5 - i.star_rating);
  return `<div style="border:1px solid #e1e4e8;border-radius:8px;padding:12px;margin-bottom:10px;">
    <div style="color:#bf8700;font-size:15px;">${stars}
      <span style="color:#57606a;font-size:13px;">&nbsp;${i.reviewer || 'Anonymous'}
      &middot; waiting ${Math.round(i.hours_waiting || 0)}h</span></div>
    <div style="margin:6px 0;font-size:14px;">${(i.comment || '(no text)').replace(/</g, '&lt;')}</div>
    ${showReply && i.reply ? `<div style="background:#f6f8fa;border-left:3px solid #0969da;padding:8px;font-size:13px;">
      <strong>Draft reply:</strong><br>${i.reply.replace(/</g, '&lt;')}</div>` : ''}
    ${i.hold_reasons && i.hold_reasons.length
      ? `<div style="color:#bc4c00;font-size:12px;margin-top:6px;">Held: ${i.hold_reasons.join('; ')}</div>` : ''}
    ${i.send_error ? `<div style="color:#cf222e;font-size:12px;margin-top:6px;">Send failed: ${i.send_error}</div>` : ''}
  </div>`;
}

const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;">
  <h2 style="margin-bottom:4px;">${loc.business_name} &mdash; Review Replies</h2>
  <p style="color:#57606a;margin-top:0;">${new Date().toDateString()}</p>

  <div style="display:flex;gap:10px;margin:16px 0;">
    <div style="flex:1;background:#dafbe1;padding:10px;border-radius:6px;text-align:center;">
      <div style="font-size:22px;font-weight:700;">${sent.length}</div>
      <div style="font-size:12px;color:#57606a;">sent</div></div>
    <div style="flex:1;background:#fff8c5;padding:10px;border-radius:6px;text-align:center;">
      <div style="font-size:22px;font-weight:700;">${held.length}</div>
      <div style="font-size:12px;color:#57606a;">need you</div></div>
    <div style="flex:1;background:#ffebe9;padding:10px;border-radius:6px;text-align:center;">
      <div style="font-size:22px;font-weight:700;">${escalated.length}</div>
      <div style="font-size:12px;color:#57606a;">escalated</div></div>
  </div>

  ${escalated.length ? `<h3 style="color:#cf222e;">Escalated &mdash; answer these yourself</h3>
    ${escalated.map((i) => card(i, true)).join('')}` : ''}

  ${held.filter((i) => !i.requires_escalation).length
    ? `<h3>Drafts awaiting your approval</h3>
       ${held.filter((i) => !i.requires_escalation).map((i) => card(i, true)).join('')}` : ''}

  ${failed.length ? `<h3 style="color:#cf222e;">Failed to send</h3>
    ${failed.map((i) => card(i, true)).join('')}` : ''}

  ${sent.length ? `<h3>Sent automatically</h3>${sent.map((i) => card(i, true)).join('')}` : ''}

  ${items.length === 0 ? '<p>No reviews were waiting for a reply.</p>' : ''}

  <p style="color:#8b949e;font-size:12px;margin-top:24px;">
    To approve a held draft, edit it in the <code>gbp_reviews</code> table and set
    <code>reply_status</code> to <code>pending</code>; the next run will send it.
  </p>
</div>`;

return [{
  json: {
    to: loc.notify_emails,
    subject: `[GBP] ${loc.business_name}: ${sent.length} replied, ${held.length} need you`,
    html,
    counts: { sent: sent.length, held: held.length, escalated: escalated.length, failed: failed.length },
  },
}];
"""

# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------
SQL_LOCATIONS = """SELECT
  l.id AS location_db_id,
  l.google_account_name,
  l.google_location_name,
  l.business_name,
  l.auto_reply_enabled,
  COALESCE(l.notify_emails, 'kn0733@gmail.com') AS notify_emails
FROM gbp_locations l
WHERE l.is_active
  AND l.deleted_at IS NULL;"""

SQL_UPSERT_REVIEWS = """-- Mirror every fetched review. Existing rows keep their AI triage and any
-- human-edited draft; only Google-sourced fields are refreshed.
INSERT INTO gbp_reviews (
  location_id, google_review_id, reviewer_display_name, is_anonymous,
  star_rating, comment, review_created_at, review_updated_at,
  reply_comment, reply_updated_at, reply_status, reply_source,
  response_latency_hours, last_synced_at
)
SELECT
  (r->>'location_id')::int,
  r->>'google_review_id',
  r->>'reviewer_display_name',
  (r->>'is_anonymous')::boolean,
  (r->>'star_rating')::smallint,
  r->>'comment',
  NULLIF(r->>'review_created_at','null')::timestamp,
  NULLIF(r->>'review_updated_at','null')::timestamp,
  NULLIF(r->>'reply_comment','null'),
  NULLIF(r->>'reply_updated_at','null')::timestamp,
  r->>'reply_status',
  NULLIF(r->>'reply_source','null'),
  NULLIF(r->>'response_latency_hours','null')::numeric,
  now()
FROM jsonb_array_elements($1::jsonb) r
ON CONFLICT (google_review_id) DO UPDATE SET
  star_rating            = EXCLUDED.star_rating,
  comment                = EXCLUDED.comment,
  review_updated_at      = EXCLUDED.review_updated_at,
  reply_comment          = COALESCE(EXCLUDED.reply_comment, gbp_reviews.reply_comment),
  reply_updated_at       = COALESCE(EXCLUDED.reply_updated_at, gbp_reviews.reply_updated_at),
  response_latency_hours = COALESCE(EXCLUDED.response_latency_hours, gbp_reviews.response_latency_hours),
  -- A reply that now exists on Google always wins; otherwise keep our own state
  -- so an awaiting_approval draft is not reset to 'none' on every sync.
  reply_status = CASE
    WHEN EXCLUDED.reply_status = 'sent' THEN 'sent'
    ELSE gbp_reviews.reply_status
  END,
  reply_source = COALESCE(gbp_reviews.reply_source, EXCLUDED.reply_source),
  last_synced_at = now(),
  -- A review Google hands back is live content again, so it re-enters the
  -- retention window rather than staying marked as redacted.
  redacted_at = NULL
RETURNING id;"""

SQL_QUEUE = """SELECT
  rv.id,
  rv.location_id,
  l.business_name,
  l.auto_reply_enabled,
  rv.google_review_id,
  rv.reviewer_display_name,
  rv.star_rating,
  rv.comment,
  rv.review_created_at,
  rv.reply_status,
  -- A human who edits the draft and sets reply_status to 'pending' is
  -- explicitly approving that exact text. The workflow must publish it
  -- verbatim rather than asking the model for a fresh draft.
  rv.ai_suggested_reply,
  ROUND(EXTRACT(EPOCH FROM (now() - rv.review_created_at)) / 3600.0, 2) AS hours_waiting
FROM gbp_reviews rv
JOIN gbp_locations l ON l.id = rv.location_id
WHERE rv.deleted_at IS NULL
  AND rv.location_id = $1::int
  AND rv.comment IS NOT NULL
  AND (
    rv.reply_status IN ('none', 'pending')
    -- Retry a failed send up to 3 times. Without this a single 403 (which is
    -- exactly what the pending allowlist produces) would strand the review in
    -- 'failed' and it would never be picked up again.
    OR (rv.reply_status = 'failed' AND (
          SELECT count(*) FROM gbp_review_reply_log lg
          WHERE lg.review_id = rv.id AND lg.outcome = 'failed') < 3)
  )
ORDER BY (rv.star_rating <= 2) DESC, rv.review_created_at ASC
LIMIT %d;""" % BATCH_LIMIT

SQL_SAVE_DRAFT = """WITH d AS (SELECT $1::jsonb AS p),
upd AS (
  UPDATE gbp_reviews SET
    ai_suggested_reply  = p->>'reply',
    sentiment           = NULLIF(p->>'sentiment','null'),
    requires_escalation = (p->>'requires_escalation')::boolean,
    escalation_reason   = NULLIF(p->>'escalation_reason','null'),
    reply_status        = p->>'reply_status',
    hold_reasons        = p->'hold_reasons',
    reply_attempts      = gbp_reviews.reply_attempts + 1,
    updated_at          = now()
  FROM d
  WHERE gbp_reviews.id = (p->>'review_db_id')::int
  RETURNING gbp_reviews.id
)
INSERT INTO gbp_review_reply_log (
  review_id, attempt_number, reply_text, generated_by, outcome,
  model_used, input_tokens, output_tokens, n8n_execution_id
)
SELECT
  upd.id,
  (SELECT COALESCE(MAX(attempt_number), 0) + 1
     FROM gbp_review_reply_log WHERE review_id = upd.id),
  COALESCE(p->>'reply', '(no reply generated)'),
  COALESCE(p->>'generated_by', 'automation'),
  'drafted',
  NULLIF(p->>'model_used','null'),
  NULLIF(p->>'input_tokens','null')::int,
  NULLIF(p->>'output_tokens','null')::int,
  $2::text
FROM upd, d
RETURNING review_id;"""

SQL_MARK_SENT = """WITH d AS (SELECT $1::jsonb AS p),
upd AS (
  UPDATE gbp_reviews SET
    reply_comment    = CASE WHEN (p->>'ok')::boolean THEN p->>'reply' ELSE gbp_reviews.reply_comment END,
    reply_updated_at = CASE WHEN (p->>'ok')::boolean THEN now() ELSE gbp_reviews.reply_updated_at END,
    reply_status     = CASE WHEN (p->>'ok')::boolean THEN 'sent' ELSE 'failed' END,
    reply_source     = CASE WHEN (p->>'ok')::boolean
                            THEN COALESCE(p->>'generated_by', 'automation')
                            ELSE gbp_reviews.reply_source END,
    reply_error      = NULLIF(p->>'error','null'),
    response_latency_hours = CASE
      WHEN (p->>'ok')::boolean
      THEN ROUND(EXTRACT(EPOCH FROM (now() - gbp_reviews.review_created_at)) / 3600.0, 2)
      ELSE gbp_reviews.response_latency_hours END,
    updated_at = now()
  FROM d
  WHERE gbp_reviews.id = (p->>'review_db_id')::int
  RETURNING gbp_reviews.id
)
INSERT INTO gbp_review_reply_log (
  review_id, attempt_number, reply_text, generated_by, outcome, http_status, api_error, n8n_execution_id
)
SELECT
  upd.id,
  (SELECT COALESCE(MAX(attempt_number), 0) + 1 FROM gbp_review_reply_log WHERE review_id = upd.id),
  p->>'reply', COALESCE(p->>'generated_by', 'automation'),
  CASE WHEN (p->>'ok')::boolean THEN 'sent' ELSE 'failed' END,
  NULLIF(p->>'http_status','null')::int,
  NULLIF(p->>'error','null'),
  $2::text
FROM upd, d
RETURNING review_id;"""

SEND_PREP = r"""
const d = $('Parse Draft').all()[$itemIndex].json;
const res = $input.item.json;
const ok = !!(res && res.comment !== undefined && res.updateTime !== undefined);
const httpStatus = res && res.error && res.error.code ? res.error.code : (ok ? 200 : null);
const errMsg = res && res.error
  ? (res.error.message || JSON.stringify(res.error))
  : (ok ? null : 'Unexpected response from the reply endpoint');

return {
  json: Object.assign({}, d, {
    ok,
    http_status: httpStatus,
    error: errMsg,
    send_outcome: ok ? 'sent' : 'failed',
    send_error: ok ? null : errMsg,
  }),
};
"""


def node(name, ntype, ver, pos, params, creds=None, on_error=None, notes=None,
         always_output=False, execute_once=False):
    n = {"parameters": params, "id": name.lower().replace(" ", "-").replace("?", ""),
         "name": name, "type": ntype, "typeVersion": ver, "position": pos}
    if creds:
        n["credentials"] = creds
    if on_error:
        n["onError"] = on_error
        n["retryOnFail"] = False
    if notes:
        n["notes"] = notes
        n["notesInFlow"] = True
    if always_output:
        n["alwaysOutputData"] = True
    if execute_once:
        n["executeOnce"] = True
    return n


nodes = [
    node("Every 4 Hours", "n8n-nodes-base.scheduleTrigger", 1.3, [-220, 300], {
        "rule": {"interval": [{"field": "hours", "hoursInterval": 4}]}
    }, notes="Reviews are time-sensitive; 4h keeps median reply latency inside the 48h target"),

    node("Get Locations", "n8n-nodes-base.postgres", 2.7, [0, 300], {
        "operation": "executeQuery", "query": SQL_LOCATIONS, "options": {},
    }, {"postgres": CRED_PG}),

    node("Fetch Reviews", "n8n-nodes-base.httpRequest", 4.5, [220, 300], {
        "url": "=https://mybusiness.googleapis.com/v4/{{ $json.google_account_name }}/{{ $json.google_location_name }}/reviews",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "googleOAuth2Api",
        "sendQuery": True, "specifyQuery": "keypair",
        "queryParameters": {"parameters": [{"name": "pageSize", "value": "50"}]},
        "options": {
            "response": {"response": {"neverError": True}}, "timeout": 30000,
            "pagination": {"pagination": {
                "paginationMode": "updateAParameterInEachRequest",
                "parameters": {"parameters": [
                    {"type": "qs", "name": "pageToken", "value": "={{ $response.body.nextPageToken }}"}]},
                "paginationCompleteWhen": "other",
                "completeExpression": "={{ !$response.body.nextPageToken }}",
                "limitPagesFetched": True, "maxRequests": 20, "requestInterval": 300,
            }},
        },
    }, {"googleOAuth2Api": CRED_GOOGLE}, on_error="continueRegularOutput",
       notes="v4 — 403 until the allowlist is approved"),

    node("Normalise Reviews", "n8n-nodes-base.code", 2, [440, 300], {
        "mode": "runOnceForAllItems", "language": "javaScript", "jsCode": NORMALISE,
    }, notes="Flattens paginated pages, maps ONE..FIVE to 1..5, computes reply latency"),

    node("Upsert Reviews", "n8n-nodes-base.postgres", 2.7, [660, 300], {
        "operation": "executeQuery", "query": SQL_UPSERT_REVIEWS,
        "options": {"queryReplacement": "={{ [ JSON.stringify($json.rows) ] }}",
                    "queryBatching": "transaction"},
    }, {"postgres": CRED_PG},
       notes="Google-sourced fields refresh; our own draft state is preserved"),

    node("Get Reply Queue", "n8n-nodes-base.postgres", 2.7, [880, 300], {
        "operation": "executeQuery", "query": SQL_QUEUE,
        "options": {"queryReplacement": "={{ [ $('Get Locations').first().json.location_db_id ] }}"},
    }, {"postgres": CRED_PG}, always_output=True, execute_once=True,
       notes="Worst ratings first, then oldest. Capped at %d per run to bound Claude spend. "
             "Execute Once: the upsert emits one item per review, and without it this query "
             "would run once per upserted row and multiply the whole queue." % BATCH_LIMIT),

    node("Anything To Answer?", "n8n-nodes-base.if", 2.3, [1100, 300], {
        "conditions": {
            "combinator": "and",
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{
                "id": "has-review",
                "leftValue": "={{ $json.google_review_id }}",
                "rightValue": "",
                "operator": {"type": "string", "operation": "exists", "singleValue": True},
            }],
        },
        "looseTypeValidation": True,
        "options": {},
    }, notes="Skips straight to the digest when the queue is empty"),

    node("Draft Reply", "n8n-nodes-base.httpRequest", 4.5, [1320, 180], {
        "method": "POST",
        "url": "https://api.anthropic.com/v1/messages",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendHeaders": True, "specifyHeaders": "keypair",
        "headerParameters": {"parameters": [
            {"name": "anthropic-version", "value": "2023-06-01"},
            {"name": "content-type", "value": "application/json"},
        ]},
        "sendBody": True, "contentType": "json", "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 700, system: 'You write replies to Google reviews on behalf of ' + $json.business_name + ', a travel company in Odisha, India. Reply in the reviewer\\'s own language. Be warm, specific and human: thank them by name, refer to what they actually mentioned, and keep it under 60 words. Never invent facts, never offer refunds, compensation or policy exceptions, and never admit legal fault. If the review describes a safety, legal or refund matter, or anything you cannot answer honestly without more information, set escalate to true. Respond with ONLY a JSON object, no prose and no code fence: {\"reply\": string, \"sentiment\": \"positive\"|\"neutral\"|\"negative\"|\"mixed\", \"escalate\": boolean, \"escalate_reason\": string}', messages: [{ role: 'user', content: 'Rating: ' + $json.star_rating + '/5\\nReviewer: ' + ($json.reviewer_display_name || 'Anonymous') + '\\nWaiting: ' + Math.round($json.hours_waiting) + ' hours\\nReview: ' + ($json.comment || '(no text)') }] }) }}",
        "options": {"response": {"response": {"neverError": True}}, "timeout": 60000,
                    "batching": {"batch": {"batchSize": 3, "batchInterval": 1500}}},
    }, {"httpHeaderAuth": CRED_ANTHROPIC}, on_error="continueRegularOutput",
       notes="Anthropic messages API. Credential: Header Auth 'x-api-key'."),

    node("Parse Draft", "n8n-nodes-base.code", 2, [1540, 180], {
        "mode": "runOnceForEachItem", "language": "javaScript", "jsCode": PARSE_DRAFT,
    }, notes="Guard rails live here — every auto-send condition must pass or the draft is held"),

    node("Save Draft", "n8n-nodes-base.postgres", 2.7, [1760, 180], {
        "operation": "executeQuery", "query": SQL_SAVE_DRAFT,
        "options": {"queryReplacement": "={{ [ JSON.stringify($json), $execution.id ] }}"},
    }, {"postgres": CRED_PG},
       notes="Persists the draft and its triage before anything is published"),

    node("Cleared To Send?", "n8n-nodes-base.if", 2.3, [1980, 180], {
        "conditions": {
            "combinator": "and",
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
            "conditions": [{
                "id": "auto-send",
                "leftValue": "={{ $('Parse Draft').all()[$itemIndex].json.can_auto_send }}",
                "rightValue": True,
                "operator": {"type": "boolean", "operation": "true", "singleValue": True},
            }],
        },
        "options": {},
    }, notes="False branch = held for a human. Nothing is published from that side."),

    node("Post Reply To Google", "n8n-nodes-base.httpRequest", 4.5, [2200, 60], {
        "method": "PUT",
        "url": "=https://mybusiness.googleapis.com/v4/{{ $('Parse Draft').all()[$itemIndex].json.google_review_id }}/reply",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "googleOAuth2Api",
        "sendBody": True, "contentType": "json", "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ comment: $('Parse Draft').all()[$itemIndex].json.reply }) }}",
        "options": {"response": {"response": {"neverError": True}}, "timeout": 30000,
                    "batching": {"batch": {"batchSize": 2, "batchInterval": 2000}}},
    }, {"googleOAuth2Api": CRED_GOOGLE}, on_error="continueRegularOutput",
       notes="THE ONLY NODE THAT PUBLISHES ANYTHING PUBLIC. v4 — 403 until allowlisted."),

    node("Record Send Result", "n8n-nodes-base.code", 2, [2420, 60], {
        "mode": "runOnceForEachItem", "language": "javaScript", "jsCode": SEND_PREP,
    }),

    node("Mark Sent", "n8n-nodes-base.postgres", 2.7, [2640, 60], {
        "operation": "executeQuery", "query": SQL_MARK_SENT,
        "options": {"queryReplacement": "={{ [ JSON.stringify($json), $execution.id ] }}"},
    }, {"postgres": CRED_PG}),

    node("Collect Results", "n8n-nodes-base.merge", 3.2, [2860, 180], {
        "mode": "append", "numberInputs": 3,
    }, notes="Sent, held, and the empty-queue path all converge here"),

    node("Build Digest", "n8n-nodes-base.code", 2, [3080, 180], {
        "mode": "runOnceForAllItems", "language": "javaScript", "jsCode": DIGEST,
    }, execute_once=True),

    node("Email Digest", "n8n-nodes-base.gmail", 2.2, [3300, 180], {
        "resource": "message", "operation": "send",
        "sendTo": "={{ $json.to }}",
        "subject": "={{ $json.subject }}",
        "emailType": "html",
        "message": "={{ $json.html }}",
        "options": {"appendAttribution": False},
    }, {"gmailOAuth2": CRED_GMAIL}),
]

connections = {
    "Every 4 Hours":      {"main": [[{"node": "Get Locations", "type": "main", "index": 0}]]},
    "Get Locations":      {"main": [[{"node": "Fetch Reviews", "type": "main", "index": 0}]]},
    "Fetch Reviews":      {"main": [[{"node": "Normalise Reviews", "type": "main", "index": 0}]]},
    "Normalise Reviews":  {"main": [[{"node": "Upsert Reviews", "type": "main", "index": 0}]]},
    "Upsert Reviews":     {"main": [[{"node": "Get Reply Queue", "type": "main", "index": 0}]]},
    "Get Reply Queue":    {"main": [[{"node": "Anything To Answer?", "type": "main", "index": 0}]]},
    "Anything To Answer?": {"main": [
        [{"node": "Draft Reply", "type": "main", "index": 0}],
        [{"node": "Collect Results", "type": "main", "index": 2}],
    ]},
    "Draft Reply":        {"main": [[{"node": "Parse Draft", "type": "main", "index": 0}]]},
    "Parse Draft":        {"main": [[{"node": "Save Draft", "type": "main", "index": 0}]]},
    "Save Draft":         {"main": [[{"node": "Cleared To Send?", "type": "main", "index": 0}]]},
    "Cleared To Send?":   {"main": [
        [{"node": "Post Reply To Google", "type": "main", "index": 0}],
        [{"node": "Collect Results", "type": "main", "index": 1}],
    ]},
    "Post Reply To Google": {"main": [[{"node": "Record Send Result", "type": "main", "index": 0}]]},
    "Record Send Result": {"main": [[{"node": "Mark Sent", "type": "main", "index": 0}]]},
    "Mark Sent":          {"main": [[{"node": "Collect Results", "type": "main", "index": 0}]]},
    "Collect Results":    {"main": [[{"node": "Build Digest", "type": "main", "index": 0}]]},
    "Build Digest":       {"main": [[{"node": "Email Digest", "type": "main", "index": 0}]]},
}


def days_ago(n):
    return (datetime.now(timezone.utc) - timedelta(days=n)).isoformat().replace("+00:00", "Z")


def hours_ago(n):
    return (datetime.now(timezone.utc) - timedelta(hours=n)).isoformat().replace("+00:00", "Z")


pin_reviews = {"reviews": [
    {"name": "accounts/106/locations/123/reviews/rev_happy",
     "reviewer": {"displayName": "Rakesh M."}, "starRating": "FIVE",
     "comment": "Booked a three day Puri and Konark trip. Driver was punctual and the hotel was exactly as promised.",
     "createTime": hours_ago(6), "updateTime": hours_ago(6)},
    {"name": "accounts/106/locations/123/reviews/rev_mixed",
     "reviewer": {"displayName": "Anita S."}, "starRating": "FOUR",
     "comment": "Good itinerary and helpful staff, though the airport pickup was about 20 minutes late.",
     "createTime": hours_ago(30), "updateTime": hours_ago(30)},
    {"name": "accounts/106/locations/123/reviews/rev_angry",
     "reviewer": {"displayName": "V. Patnaik"}, "starRating": "ONE",
     "comment": "Terrible. The cab never arrived and nobody picked up the phone. I want a full refund or I will speak to my lawyer.",
     "createTime": hours_ago(50), "updateTime": hours_ago(50)},
    {"name": "accounts/106/locations/123/reviews/rev_done",
     "reviewer": {"displayName": "S. Das"}, "starRating": "FOUR",
     "comment": "Nice tour, good value for money.",
     "createTime": days_ago(30), "updateTime": days_ago(30),
     "reviewReply": {"comment": "Thank you for travelling with us!", "updateTime": days_ago(29)}},
], "averageRating": 3.5, "totalReviewCount": 4}

pin_claude_positive = {
    "id": "msg_pin_1", "model": "claude-sonnet-4-5", "role": "assistant",
    "content": [{"type": "text", "text": json.dumps({
        "reply": "Thank you so much, Rakesh! We are glad the Puri and Konark itinerary ran smoothly and that your driver was on time. We would love to plan your next Odisha trip.",
        "sentiment": "positive", "escalate": False, "escalate_reason": ""})}],
    "usage": {"input_tokens": 420, "output_tokens": 62},
}

workflow = {
    "name": "GBP Review Response",
    "nodes": nodes,
    "connections": connections,
    "pinData": {"Fetch Reviews": [{"json": pin_reviews}]},
    "settings": {"executionOrder": "v1", "saveManualExecutions": True,
                 "callerPolicy": "workflowsFromSameOwner"},
    "meta": {"instanceId": "gbp-automation"},
    "tags": [],
}

out = pathlib.Path("workflows/GBP_Review_Response.json")
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(workflow, indent=2))
print(f"Wrote {out}  ({out.stat().st_size:,} bytes, {len(nodes)} nodes)")

# Also emit the pinned Claude response for the test harness.
pathlib.Path("workflows/.fixtures").mkdir(exist_ok=True)
pathlib.Path("workflows/.fixtures/claude_positive.json").write_text(json.dumps(pin_claude_positive))
