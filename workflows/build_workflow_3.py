#!/usr/bin/env python3
"""Generate the GBP Content Management workflow JSON for n8n import."""
import json, pathlib
from datetime import datetime, timedelta, timezone

CRED_GOOGLE = {"id": "pMOKted8v0rROW9p", "name": "GBP Automation OAuth"}
CRED_PG     = {"id": "73038PPSx78LOwXp", "name": "GBP Postgres"}
CRED_GMAIL  = {"id": "kSrGTNfsbOFylPXx", "name": "Gmail - info@negotrip.com"}
CRED_ANTHROPIC = {"id": "B1UfRtUbk4dYzhuw", "name": "Anthropic API"}

SUMMARY_MAX = 1500       # Google's local post summary limit
SIMILARITY_MAX = 0.55    # reject a draft this close to a post from the last 90 days
PUBLISH_LIMIT = 5        # posts published per run

# ---------------------------------------------------------------------------
# Validation — the gate between the model and a public post
# ---------------------------------------------------------------------------
VALIDATE = r"""
const loc = $('Get Locations').first().json;
const ctx = $('Get Content Context').first().json;
const SUMMARY_MAX = __SUMMARY_MAX__;
const SIMILARITY_MAX = __SIMILARITY_MAX__;

// --- parse the model output defensively -------------------------------------
let parsed = null, parseError = null;
try {
  const res = $input.item.json;
  const text = res && res.content && res.content[0] ? res.content[0].text : null;
  if (!text) throw new Error('Claude returned no content');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in the model output');
  parsed = JSON.parse(match[0]);
} catch (e) { parseError = e.message; }

const summary  = parsed && typeof parsed.summary === 'string' ? parsed.summary.trim() : null;
const topic    = parsed && ['STANDARD', 'EVENT', 'OFFER'].includes(parsed.topic_type)
  ? parsed.topic_type : 'STANDARD';
const ctaType  = parsed && parsed.cta_type ? String(parsed.cta_type).toUpperCase() : null;
const ctaUrl   = parsed && parsed.cta_url ? String(parsed.cta_url).trim() : null;

const VALID_CTA = ['BOOK','ORDER','SHOP','LEARN_MORE','SIGN_UP','CALL','GET_OFFER'];

// --- allowed link destinations ----------------------------------------------
// A published post must never point somewhere the model invented. Only the
// business's own website host (and its subdomains) is acceptable.
// The Code sandbox does not expose the WHATWG URL constructor, so parse the
// host with a regex instead. Using `new URL` here silently threw, allowedHost
// came back null, and EVERY link — including legitimate negotrip.in ones — was
// held as "not on the business website".
function hostOf(u) {
  const m = /^https?:\/\/([^/?#]+)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '') : null;
}

const allowedHost = hostOf(loc.website_url);

function hostAllowed(u) {
  if (!allowedHost) return false;
  // A published link must be https, whatever the business website itself uses.
  if (!/^https:\/\//i.test(String(u || ''))) return false;
  const h = hostOf(u);
  return !!h && (h === allowedHost || h.endsWith('.' + allowedHost));
}

// --- similarity against the last 90 days of posts ---------------------------
function tokens(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter((w) => w.length > 3));
}
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((w) => { if (B.has(w)) inter += 1; });
  return inter / (A.size + B.size - inter);
}
const recent = ctx.recent_summaries || [];
let closest = 0, closestText = null;
recent.forEach((r) => {
  const s = jaccard(summary || '', r);
  if (s > closest) { closest = s; closestText = r; }
});
closest = Math.round(closest * 100) / 100;

// --- claims that need a human to stand behind them --------------------------
// Superlatives and guarantees are advertising claims. Prices, discounts and
// contact details in a post are either against Google's content policy or
// something the model has no authority to invent.
const CLAIM_WORDS = /\b(best|cheapest|number one|no\.? ?1|guaranteed|guarantee|unbeatable|lowest price|world class|award winning|certified|official partner)\b/i;
const CONTACT_IN_BODY = /(\+?\d[\d\s\-()]{8,}\d)|\b[\w.+-]+@[\w-]+\.[\w.]+\b/;
const MONEY = /(₹|rs\.?|inr|\$|usd)\s?\d/i;
const DISCOUNT = /\b(\d{1,2}|100)\s?%\s?(off|discount)\b/i;

const holds = [];
if (parseError)                 holds.push('model output could not be parsed: ' + parseError);
if (!summary)                   holds.push('no post text produced');
if (summary && summary.length < 60)          holds.push('post is too short to be useful');
if (summary && summary.length > SUMMARY_MAX) holds.push('post exceeds Google limit of ' + SUMMARY_MAX + ' characters');
if (ctaType && !VALID_CTA.includes(ctaType)) holds.push('unrecognised call-to-action type: ' + ctaType);
if (ctaType && !ctaUrl && ctaType !== 'CALL') holds.push('call-to-action has no link');
if (ctaUrl && !hostAllowed(ctaUrl))          holds.push('link is not on ' + (allowedHost || 'the business website') + ': ' + ctaUrl);
if (summary && CLAIM_WORDS.test(summary))    holds.push('contains an advertising claim a person should approve');
if (summary && CONTACT_IN_BODY.test(summary)) holds.push('contains a phone number or email, which Google does not allow in posts');
if (summary && MONEY.test(summary))          holds.push('quotes a price — verify it is current before publishing');
if (summary && DISCOUNT.test(summary))       holds.push('advertises a discount the automation cannot verify');
if (closest >= SIMILARITY_MAX)               holds.push('too similar (' + closest + ') to a recent post');
if (topic === 'OFFER')                       holds.push('offers are never published automatically');
if (topic === 'EVENT')                       holds.push('events need real dates a person must confirm');
if (!loc.auto_post_enabled)                  holds.push('auto-posting is switched off for this location');

const canAutoPublish = holds.length === 0;

// Media: only ever a photo already on the profile, never an invented URL.
const mediaUrl = ctx.candidate_media_url && /^https:\/\//.test(ctx.candidate_media_url)
  ? ctx.candidate_media_url : null;

return {
  json: {
    location_id: loc.location_db_id,
    business_name: loc.business_name,
    notify_emails: loc.notify_emails,
    topic_type: topic,
    summary,
    cta_type: ctaType,
    cta_url: ctaUrl,
    media_url: mediaUrl,
    media_type: mediaUrl ? 'PHOTO' : null,
    similarity: closest,
    similar_to: closest >= SIMILARITY_MAX ? closestText : null,
    hold_reasons: holds,
    can_auto_publish: canAutoPublish,
    status: canAutoPublish ? 'scheduled' : 'awaiting_approval',
    generated_by: 'automation',
    model_used: (($input.item.json || {}).model) || 'claude-sonnet-4-5',
  },
};
""".replace("__SUMMARY_MAX__", str(SUMMARY_MAX)).replace("__SIMILARITY_MAX__", str(SIMILARITY_MAX))

# ---------------------------------------------------------------------------
# Build the v4 request body for one due post
# ---------------------------------------------------------------------------
BUILD_BODY = r"""
const p = $input.item.json;
const body = {
  languageCode: p.language_code || 'en',
  summary: p.summary,
  topicType: p.topic_type || 'STANDARD',
};
if (p.cta_type) {
  body.callToAction = { actionType: p.cta_type };
  if (p.cta_type !== 'CALL' && p.cta_url) body.callToAction.url = p.cta_url;
}
if (p.media_url) {
  body.media = [{ mediaFormat: p.media_type || 'PHOTO', sourceUrl: p.media_url }];
}
return { json: { post_db_id: p.id, parent: p.parent, body, preview: p } };
"""

RECORD_PUBLISH = r"""
const prep = $('Build Post Body').all()[$itemIndex].json;
const res = $input.item.json;
const ok = !!(res && res.name && res.state !== 'REJECTED');

let error = null;
if (!ok) {
  error = res && res.error ? (res.error.message || JSON.stringify(res.error))
        : (res && res.state === 'REJECTED' ? 'Google rejected the post content'
        : 'Unexpected response from the localPosts endpoint');
}

// A media failure is worth calling out separately — the same text usually
// publishes fine without the photo.
const mediaProblem = !!(error && /media|image|photo|sourceUrl/i.test(error));

return {
  json: Object.assign({}, prep.preview, {
    post_db_id: prep.post_db_id,
    ok,
    google_post_name: ok ? res.name : null,
    http_status: res && res.error && res.error.code ? res.error.code : (ok ? 200 : null),
    error,
    media_problem: mediaProblem,
    publish_outcome: ok ? 'published' : 'failed',
  }),
};
"""

DIGEST = r"""
const items = $input.all().map((i) => i.json);
const loc = $('Get Locations').first().json;

const published = items.filter((i) => i.publish_outcome === 'published');
const failed    = items.filter((i) => i.publish_outcome === 'failed');
const held      = items.filter((i) => i.can_auto_publish === false);

function esc(s) { return String(s == null ? '' : s).replace(/</g, '&lt;'); }

function card(i) {
  return `<div style="border:1px solid #e1e4e8;border-radius:8px;padding:12px;margin-bottom:10px;">
    <div style="font-size:12px;color:#57606a;text-transform:uppercase;letter-spacing:.04em;">
      ${esc(i.topic_type || 'STANDARD')}${i.similarity !== undefined ? ` &middot; similarity ${i.similarity}` : ''}</div>
    <div style="margin:6px 0;font-size:14px;">${esc(i.summary)}</div>
    ${i.cta_type ? `<div style="font-size:13px;color:#0969da;">${esc(i.cta_type)} &rarr; ${esc(i.cta_url || '')}</div>` : ''}
    ${i.media_url ? `<div style="font-size:12px;color:#57606a;">with photo</div>` : ''}
    ${i.hold_reasons && i.hold_reasons.length
      ? `<div style="color:#bc4c00;font-size:12px;margin-top:6px;">Held: ${esc(i.hold_reasons.join('; '))}</div>` : ''}
    ${i.error ? `<div style="color:#cf222e;font-size:12px;margin-top:6px;">Failed: ${esc(i.error)}${
        i.media_problem ? ' &mdash; try again without the photo' : ''}</div>` : ''}
    ${i.google_post_name ? `<div style="color:#1a7f37;font-size:12px;margin-top:6px;">Published</div>` : ''}
  </div>`;
}

const html = `
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;">
  <h2 style="margin-bottom:4px;">${esc(loc.business_name)} &mdash; Profile Posts</h2>
  <p style="color:#57606a;margin-top:0;">${new Date().toDateString()}</p>

  <div style="display:flex;gap:10px;margin:16px 0;">
    <div style="flex:1;background:#dafbe1;padding:10px;border-radius:6px;text-align:center;">
      <div style="font-size:22px;font-weight:700;">${published.length}</div>
      <div style="font-size:12px;color:#57606a;">published</div></div>
    <div style="flex:1;background:#fff8c5;padding:10px;border-radius:6px;text-align:center;">
      <div style="font-size:22px;font-weight:700;">${held.length}</div>
      <div style="font-size:12px;color:#57606a;">awaiting you</div></div>
    <div style="flex:1;background:#ffebe9;padding:10px;border-radius:6px;text-align:center;">
      <div style="font-size:22px;font-weight:700;">${failed.length}</div>
      <div style="font-size:12px;color:#57606a;">failed</div></div>
  </div>

  ${held.length ? `<h3>Drafts awaiting your approval</h3>${held.map(card).join('')}` : ''}
  ${failed.length ? `<h3 style="color:#cf222e;">Failed to publish</h3>${failed.map(card).join('')}` : ''}
  ${published.length ? `<h3>Published</h3>${published.map(card).join('')}` : ''}
  ${items.length === 0 ? '<p>Nothing to post this cycle.</p>' : ''}

  <p style="color:#8b949e;font-size:12px;margin-top:24px;">
    To approve a draft, edit it in <code>gbp_posts</code> and set <code>status</code>
    to <code>scheduled</code> with a <code>scheduled_for</code> time. The next run publishes it.
  </p>
</div>`;

return [{
  json: {
    to: loc.notify_emails,
    subject: `[GBP] ${loc.business_name}: ${published.length} posted, ${held.length} awaiting you`,
    html,
    counts: { published: published.length, held: held.length, failed: failed.length },
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
  l.website_url,
  l.city,
  l.primary_category,
  l.auto_post_enabled,
  COALESCE(l.notify_emails, 'kn0733@gmail.com') AS notify_emails
FROM gbp_locations l
WHERE l.is_active
  AND l.deleted_at IS NULL;"""

SQL_CONTEXT = """SELECT
  -- What we have already said, so the model does not repeat itself
  COALESCE(
    (SELECT jsonb_agg(summary ORDER BY published_at DESC)
       FROM (SELECT summary, published_at FROM gbp_posts
              WHERE location_id = $1::int AND deleted_at IS NULL
                AND summary IS NOT NULL
                AND COALESCE(published_at, created_at) > now() - INTERVAL '90 days'
              ORDER BY COALESCE(published_at, created_at) DESC LIMIT 12) s),
    '[]'::jsonb) AS recent_summaries,

  -- Real services, so the post is grounded in what the business actually sells
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('name', display_name, 'description', description))
       FROM (SELECT display_name, description FROM gbp_services
              WHERE location_id = $1::int AND deleted_at IS NULL
              ORDER BY id LIMIT 12) sv),
    '[]'::jsonb) AS services,

  -- A photo already on the profile; never an invented image URL
  (SELECT google_url FROM gbp_media
     WHERE location_id = $1::int AND deleted_at IS NULL
       AND is_owner_uploaded AND media_format = 'PHOTO'
       AND google_url LIKE 'https://%'
     ORDER BY media_created_at DESC NULLS LAST LIMIT 1) AS candidate_media_url,

  (SELECT count(*) FROM gbp_posts
     WHERE location_id = $1::int AND status = 'published'
       AND published_at > now() - INTERVAL '30 days') AS posts_last_30_days,

  (SELECT max(published_at) FROM gbp_posts
     WHERE location_id = $1::int AND status = 'published') AS last_published_at;"""

SQL_SAVE_DRAFT = """WITH d AS (SELECT $1::jsonb AS p)
INSERT INTO gbp_posts (
  post_id, location_id, topic_type, summary, language_code,
  cta_type, cta_url, media_url, media_type,
  status, scheduled_for, generated_by, model_used, n8n_execution_id,
  hold_reasons
)
SELECT
  -- A second-resolution timestamp alone collides when two drafts are saved in
  -- the same second (a manual re-run does exactly that), and the unique
  -- constraint would abort the whole execution. The random suffix makes the
  -- id collision-proof; ON CONFLICT below is the belt-and-braces.
  'post_' || to_char(now(), 'YYYYMMDD_HH24MISS') || '_' || (p->>'location_id')
    || '_' || substr(md5(random()::text), 1, 6),
  (p->>'location_id')::int,
  p->>'topic_type',
  p->>'summary',
  'en',
  NULLIF(p->>'cta_type','null'),
  NULLIF(p->>'cta_url','null'),
  NULLIF(p->>'media_url','null'),
  NULLIF(p->>'media_type','null'),
  p->>'status',
  CASE WHEN p->>'status' = 'scheduled' THEN now() ELSE NULL END,
  'automation',
  NULLIF(p->>'model_used','null'),
  $2::text,
  p->'hold_reasons'
FROM d
WHERE p->>'summary' IS NOT NULL
ON CONFLICT (post_id) DO NOTHING
RETURNING id, post_id, status;"""

SQL_DUE_POSTS = """SELECT
  po.id,
  po.post_id,
  po.location_id,
  po.topic_type,
  po.summary,
  po.language_code,
  po.cta_type,
  po.cta_url,
  po.media_url,
  po.media_type,
  po.status,
  l.google_account_name || '/' || l.google_location_name AS parent,
  l.business_name
FROM gbp_posts po
JOIN gbp_locations l ON l.id = po.location_id
WHERE po.deleted_at IS NULL
  AND po.location_id = $1::int
  AND po.status = 'scheduled'
  AND (po.scheduled_for IS NULL OR po.scheduled_for <= now())
  AND po.publish_attempts < 3
ORDER BY po.scheduled_for NULLS FIRST, po.id
LIMIT __LIMIT__;""".replace("__LIMIT__", str(PUBLISH_LIMIT))

SQL_MARK_PUBLISHED = """WITH d AS (SELECT $1::jsonb AS p)
UPDATE gbp_posts SET
  status           = CASE WHEN (p->>'ok')::boolean THEN 'published' ELSE 'failed' END,
  google_post_name = NULLIF(p->>'google_post_name','null'),
  published_at     = CASE WHEN (p->>'ok')::boolean THEN now() ELSE published_at END,
  publish_error    = NULLIF(p->>'error','null'),
  publish_attempts = gbp_posts.publish_attempts + 1,
  updated_at       = now()
FROM d
WHERE gbp_posts.id = (p->>'post_db_id')::int
RETURNING gbp_posts.id, gbp_posts.status;"""


def node(name, ntype, ver, pos, params, creds=None, on_error=None, notes=None,
         always_output=False, execute_once=False):
    n = {"parameters": params, "id": name.lower().replace(" ", "-").replace("?", ""),
         "name": name, "type": ntype, "typeVersion": ver, "position": pos}
    if creds: n["credentials"] = creds
    if on_error:
        n["onError"] = on_error
        n["retryOnFail"] = False
    if notes:
        n["notes"] = notes
        n["notesInFlow"] = True
    if always_output: n["alwaysOutputData"] = True
    if execute_once: n["executeOnce"] = True
    return n


PROMPT_SYSTEM = (
    "You write Google Business Profile posts for {name}, {category} in {city}, India. "
    "Ground every post in the services listed below — never invent a service, a price, "
    "a discount, a date, an award or a partnership. Do not include phone numbers, email "
    "addresses or prices. Do not use superlatives such as best, cheapest or guaranteed. "
    "Write 80-200 words in warm plain English, one specific idea per post, and make it "
    "clearly different from the recent posts listed. Respond with ONLY a JSON object, no "
    "prose and no code fence: "
    '{{"summary": string, "topic_type": "STANDARD", "cta_type": "LEARN_MORE"|"BOOK"|null, '
    '"cta_url": string|null, "rationale": string}}. '
    "cta_url must be a page on {website} or null."
)

nodes = [
    node("Weekly Schedule", "n8n-nodes-base.scheduleTrigger", 1.3, [-220, 300], {
        "rule": {"interval": [{"field": "weeks", "triggerAtDay": [2], "triggerAtHour": 10, "triggerAtMinute": 0}]}
    }, notes="Tuesday 10:00. One post a week keeps the Content dimension healthy without spamming."),

    node("Get Locations", "n8n-nodes-base.postgres", 2.7, [0, 300], {
        "operation": "executeQuery", "query": SQL_LOCATIONS, "options": {},
    }, {"postgres": CRED_PG}),

    node("Get Content Context", "n8n-nodes-base.postgres", 2.7, [220, 300], {
        "operation": "executeQuery", "query": SQL_CONTEXT,
        "options": {"queryReplacement": "={{ [ $json.location_db_id ] }}"},
    }, {"postgres": CRED_PG},
       notes="Real services + the last 12 posts, so the model stays grounded and does not repeat itself"),

    node("Generate Post", "n8n-nodes-base.httpRequest", 4.5, [440, 300], {
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
        "jsonBody": (
            "={{ JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 900, "
            "system: " + json.dumps(PROMPT_SYSTEM)
            + ".replace('{name}', $('Get Locations').first().json.business_name)"
              ".replace('{category}', $('Get Locations').first().json.primary_category || 'a travel business')"
              ".replace('{city}', $('Get Locations').first().json.city || 'Odisha')"
              ".replace('{website}', $('Get Locations').first().json.website_url || ''), "
            "messages: [{ role: 'user', content: "
            "'Services we actually offer:\\n' + JSON.stringify($json.services) + "
            "'\\n\\nPosts from the last 90 days (do not repeat these):\\n' + JSON.stringify($json.recent_summaries) + "
            "'\\n\\nWrite one new post.' }] }) }}"
        ),
        "options": {"response": {"response": {"neverError": True}}, "timeout": 60000},
    }, {"httpHeaderAuth": CRED_ANTHROPIC}, on_error="continueRegularOutput",
       notes="Anthropic messages API. Credential: Header Auth 'x-api-key'."),

    node("Validate Post", "n8n-nodes-base.code", 2, [660, 300], {
        "mode": "runOnceForEachItem", "language": "javaScript", "jsCode": VALIDATE,
    }, notes="Link allow-list, claim detection, duplicate check. Nothing publishes without passing."),

    node("Save Draft", "n8n-nodes-base.postgres", 2.7, [880, 300], {
        "operation": "executeQuery", "query": SQL_SAVE_DRAFT,
        "options": {"queryReplacement": "={{ [ JSON.stringify($json), $execution.id ] }}"},
    }, {"postgres": CRED_PG}, always_output=True),

    node("Get Due Posts", "n8n-nodes-base.postgres", 2.7, [1100, 300], {
        "operation": "executeQuery", "query": SQL_DUE_POSTS,
        "options": {"queryReplacement": "={{ [ $('Get Locations').first().json.location_db_id ] }}"},
    }, {"postgres": CRED_PG}, always_output=True, execute_once=True,
       notes="Fresh auto-approved drafts plus anything a human scheduled since the last run. "
             "Execute Once: without it this query reruns for every item Save Draft emits."),

    node("Anything To Publish?", "n8n-nodes-base.if", 2.3, [1320, 300], {
        "conditions": {
            "combinator": "and",
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "conditions": [{
                "id": "has-post",
                "leftValue": "={{ $json.summary }}",
                "rightValue": "",
                "operator": {"type": "string", "operation": "exists", "singleValue": True},
            }],
        },
        "looseTypeValidation": True, "options": {},
    }),

    node("Build Post Body", "n8n-nodes-base.code", 2, [1540, 180], {
        "mode": "runOnceForEachItem", "language": "javaScript", "jsCode": BUILD_BODY,
    }),

    node("Publish To Google", "n8n-nodes-base.httpRequest", 4.5, [1760, 180], {
        "method": "POST",
        "url": "=https://mybusiness.googleapis.com/v4/{{ $json.parent }}/localPosts",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "googleOAuth2Api",
        "sendBody": True, "contentType": "json", "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json.body) }}",
        "options": {"response": {"response": {"neverError": True}}, "timeout": 30000,
                    "batching": {"batch": {"batchSize": 1, "batchInterval": 2000}}},
    }, {"googleOAuth2Api": CRED_GOOGLE}, on_error="continueRegularOutput",
       notes="THE ONLY NODE THAT PUBLISHES ANYTHING PUBLIC. v4 — 403 until allowlisted."),

    node("Record Publish Result", "n8n-nodes-base.code", 2, [1980, 180], {
        "mode": "runOnceForEachItem", "language": "javaScript", "jsCode": RECORD_PUBLISH,
    }),

    node("Mark Published", "n8n-nodes-base.postgres", 2.7, [2200, 180], {
        "operation": "executeQuery", "query": SQL_MARK_PUBLISHED,
        "options": {"queryReplacement": "={{ [ JSON.stringify($json) ] }}"},
    }, {"postgres": CRED_PG}),

    node("Collect Results", "n8n-nodes-base.merge", 3.2, [2420, 300], {
        "mode": "append", "numberInputs": 3,
    }, notes="Published, the new draft, and the nothing-to-publish path all converge here"),

    node("Build Digest", "n8n-nodes-base.code", 2, [2640, 300], {
        "mode": "runOnceForAllItems", "language": "javaScript", "jsCode": DIGEST,
    }, execute_once=True),

    node("Email Digest", "n8n-nodes-base.gmail", 2.2, [2860, 300], {
        "resource": "message", "operation": "send",
        "sendTo": "={{ $json.to }}", "subject": "={{ $json.subject }}",
        "emailType": "html", "message": "={{ $json.html }}",
        "options": {"appendAttribution": False},
    }, {"gmailOAuth2": CRED_GMAIL}),
]

connections = {
    "Weekly Schedule":      {"main": [[{"node": "Get Locations", "type": "main", "index": 0}]]},
    "Get Locations":        {"main": [[{"node": "Get Content Context", "type": "main", "index": 0}]]},
    "Get Content Context":  {"main": [[{"node": "Generate Post", "type": "main", "index": 0}]]},
    "Generate Post":        {"main": [[{"node": "Validate Post", "type": "main", "index": 0}]]},
    "Validate Post":        {"main": [[{"node": "Save Draft", "type": "main", "index": 0}]]},
    "Save Draft":           {"main": [[{"node": "Get Due Posts", "type": "main", "index": 0}]]},
    "Get Due Posts":        {"main": [[{"node": "Anything To Publish?", "type": "main", "index": 0}]]},
    "Anything To Publish?": {"main": [
        [{"node": "Build Post Body", "type": "main", "index": 0}],
        [{"node": "Collect Results", "type": "main", "index": 2}],
    ]},
    "Build Post Body":      {"main": [[{"node": "Publish To Google", "type": "main", "index": 0}]]},
    "Publish To Google":    {"main": [[{"node": "Record Publish Result", "type": "main", "index": 0}]]},
    "Record Publish Result":{"main": [[{"node": "Mark Published", "type": "main", "index": 0}]]},
    "Mark Published":       {"main": [[{"node": "Collect Results", "type": "main", "index": 0}]]},
    "Collect Results":      {"main": [[{"node": "Build Digest", "type": "main", "index": 0}]]},
    "Build Digest":         {"main": [[{"node": "Email Digest", "type": "main", "index": 0}]]},
}

# The validated draft also needs to reach the digest even when it is held.
connections["Validate Post"]["main"][0].append(
    {"node": "Collect Results", "type": "main", "index": 1})

pin_claude = {
    "id": "msg_pin", "model": "claude-sonnet-4-5", "role": "assistant",
    "content": [{"type": "text", "text": json.dumps({
        "summary": ("Planning a Puri trip this season? Our day tour leaves Bhubaneswar early, "
                    "reaches Jagannath Temple before the midday crowds, and stops at Konark on the "
                    "way back so you see both without rushing. We arrange the cab, the driver and "
                    "the timings; you decide how long to spend at each stop. Tell us your dates and "
                    "we will put an itinerary together."),
        "topic_type": "STANDARD", "cta_type": "LEARN_MORE",
        "cta_url": "https://negotrip.in/puri-day-tour",
        "rationale": "Grounded in the Puri day tour service; no recent post covers it."})}],
    "usage": {"input_tokens": 900, "output_tokens": 180},
}

workflow = {
    "name": "GBP Content Management",
    "nodes": nodes,
    "connections": connections,
    "pinData": {"Generate Post": [{"json": pin_claude}]},
    "settings": {"executionOrder": "v1", "saveManualExecutions": True,
                 "callerPolicy": "workflowsFromSameOwner"},
    "meta": {"instanceId": "gbp-automation"},
    "tags": [],
}

out = pathlib.Path("workflows/GBP_Content_Management.json")
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(workflow, indent=2))
print(f"Wrote {out}  ({out.stat().st_size:,} bytes, {len(nodes)} nodes)")
