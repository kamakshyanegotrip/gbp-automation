# Console API contract

The console is a static page. It holds no data and no credentials. Everything it
displays is fetched at runtime from one n8n webhook, authenticated with a bearer
token the operator enters once.

This file is the contract that webhook must satisfy.

---

## Why it is shaped this way

GitHub Pages is public — including Pages served from a private repository, on
every plan below Enterprise. So the deployed page must never contain data.

That is not only a privacy preference. Publishing review text, reviewer names or
client performance figures to an open URL would breach two commitments already
made: the 30-day limited-use term in the Assign Over privacy policy, and Google's
Business Profile API terms on redistributing Google content.

Hence: **public code, private data.** The page is a shell; the data arrives over
an authenticated call and is never written to disk.

---

## Authentication

`Authorization: Bearer <token>`

Configure the webhook node's authentication as **Header Auth** with a credential
holding `Authorization` / `Bearer <token>`. Create a dedicated credential for
this — do not reuse a credential that exists for another service.

**The workflow must not be activated until that credential is attached.** An
active webhook with no auth is an open, unauthenticated read of the whole
database.

Reject anything unauthenticated with `401`. Never return partial data to an
unauthenticated caller.

---

## GET — dashboard payload

```
GET {endpoint}?action=overview
```

Returns one JSON object. Every key is an array; an empty array is valid and the
console renders the empty state. A missing key is treated as empty.

```jsonc
{
  "generatedAt": "2026-09-25T09:00:00Z",

  "clients": [
    { "id": 1, "client_code": "negotrip", "client_name": "Negotrip", "status": "active" }
  ],

  "locations": [
    { "id": 1, "business_name": "Negotrip", "city": "Bhubaneswar",
      "client_id": 1, "client_name": "Negotrip",
      "api_reachable": true, "auto_reply_enabled": false, "auto_post_enabled": false }
  ],

  // one row per location — v_gbp_latest_health
  "health": [
    { "location_id": 1, "business_name": "Negotrip",
      "overall_score": 54.91, "grade": "D",
      "business_info_score": 72.0, "photos_score": 31.5, "reviews_score": 68.0,
      "profile_score": 55.0, "content_score": 22.0, "services_score": 60.0,
      "score_delta": 2.35, "scored_at": "2026-09-25T03:00:00Z",
      "ai_summary": "…" }
  ],

  // v_gbp_open_recommendations, already ordered by priority_rank
  "recommendations": [
    { "id": 1, "location_id": 1, "business_name": "Negotrip",
      "dimension_name": "Photos", "priority": "critical",
      "title": "…", "detail": "…", "points_recoverable": 12.5 }
  ],

  // v_gbp_pending_replies. review_url and comment_truncated are extra —
  // see the notes below; both are optional and degrade cleanly if absent.
  "reviewQueue": [
    { "id": 101, "location_id": 1, "business_name": "Negotrip",
      "google_review_id": "Ci9DQUlR…", "reviewer_display_name": "A. Sample",
      "star_rating": 5, "comment": "…", "comment_truncated": false,
      "sentiment": "positive", "requires_escalation": false, "failed_attempts": 0,
      "ai_suggested_reply": "…", "reply_status": "awaiting_approval",
      "review_created_at": "2026-09-24T11:00:00Z", "hours_waiting": 22.0,
      "review_url": "https://business.google.com/n/…/reviews/…?fid=…" }
  ],

  // gbp_posts WHERE status IN ('draft','awaiting_approval')
  "postQueue": [
    { "id": 201, "post_id": "…", "location_id": 1, "business_name": "Negotrip",
      "topic_type": "STANDARD", "summary": "…",
      "cta_type": "BOOK", "cta_url": "https://…",
      "status": "awaiting_approval", "scheduled_for": null }
  ],

  // gbp_performance_monthly, newest first; the console shows the last 6
  "performance": [
    { "location_id": 1, "period_month": "2026-09-01",
      "total_interactions": 104, "profile_views": 529, "calls": 17,
      "website_visits": 17, "direction_requests": 12, "searches": 240 }
  ],

  // gbp_profile_alerts; the console banners unacknowledged ones
  "alerts": [
    { "id": 1, "location_id": 1, "alert_type": "post_removed",
      "severity": "critical", "subject": "…",
      "occurred_at": "2026-06-03T08:00:00Z", "acknowledged_at": null }
  ],

  // v_gbp_score_trend, ascending by score_date
  "trend": [
    { "location_id": 1, "score_date": "2026-09-01", "avg_overall": 52.4 }
  ]
}
```

### Two fields worth building deliberately

**`review_url`** is not a column. Build it for email-sourced rows only:

```
https://business.google.com/n/{discovered_account_id}/reviews/{google_review_id}?fid={discovered_location_fid}
```

API-sourced rows store a full resource name that these URLs cannot use, so leave
`review_url` null for them rather than constructing something that 404s.

**`comment_truncated`** already exists on `gbp_reviews` (migration 009). Pass it
through. The console shows a visible warning on truncated reviews, because a
reply drafted from half a review must never be approved blind.

---

## POST — approvals

```
POST {endpoint}
Content-Type: application/json
```

```jsonc
{ "action": "approve_reply", "id": 101, "text": "the final wording" }
```

| action | effect |
|---|---|
| `approve_reply` | set `ai_suggested_reply = text`, `reply_status = 'pending'` on `gbp_reviews` |
| `reject_reply`  | set `reply_status = 'rejected'` |
| `approve_post`  | set `summary = text`, `status = 'scheduled'`, `scheduled_for = now()` on `gbp_posts` |
| `reject_post`   | set `status = 'rejected'` |

Respond `{ "ok": true, "id": 101 }`, or a non-2xx with a message the console can
display.

**Approving sets state, it does not publish.** The existing Review Response and
Content Management workflows pick up `pending` / `scheduled` rows on their next
run and publish that exact text verbatim. Keeping publication in those workflows
means the console never needs Google credentials and one code path does all
publishing.

`text` is operator-edited and must be treated as untrusted input: parameterise
the query, never interpolate.

---

## What the console deliberately cannot do

- Delete anything.
- Change `auto_reply_enabled` or `auto_post_enabled`. Those switch the system
  from suggest-only to autonomous publishing and should stay a deliberate
  database change, not a button.
- Read or write Google directly. Everything goes through n8n.
