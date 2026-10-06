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

The whole body arrives at the database as **one jsonb parameter**. Operator text
is never interpolated, and adding an action needs no change to the node's
parameter wiring. `text` is still untrusted input — that is the point of the
single parameter, not an excuse to relax.

| action | effect |
|---|---|
| `approve_reply` | set `ai_suggested_reply = text`, `reply_status = 'pending'` on `gbp_reviews` |
| `reject_reply`  | set `reply_status = 'skipped'` on `gbp_reviews` — **not** `'rejected'`, see below |
| `approve_post`  | set `summary = text`, `status = 'scheduled'`, `scheduled_for = now()` on `gbp_posts` |
| `reject_post`   | set `status = 'rejected'` on `gbp_posts` |

The two rejects write different words, and the difference is not cosmetic. The
`reply_status` CHECK constraint on `gbp_reviews` permits
`none / pending / drafted / awaiting_approval / sent / failed / skipped` — there
is no `'rejected'`, so writing it fails the whole statement. `gbp_posts.status`
does allow `'rejected'`. Check the constraint before adding any new status
value; this contract claimed `'rejected'` for both until the schema disagreed.

| `save_post` | set `summary`, `cta_type`, `cta_url` — **without** approving, so a draft can be worked on across sessions |
| `create_post` | insert a post written by a person: `location_id` + `text`, optional `cta_type`, `cta_url`, `topic_type`. Lands as `awaiting_approval` with `generated_by = 'operator'` |
| `update_location` | `location_id` plus `audit_enabled` and/or `notify_emails` — **and nothing else** |
| `update_client` | `id` plus `client_name`, `contact_email`, `notify_emails`, `status` |
| `record_appeal` | `id` plus `outcome`, `outcome_clause`, `case_reference`, `notes`, `status`. Setting an outcome stamps `responded_at`; `status: "closed"` stamps `closed_at` |

`update_location` deliberately cannot touch `auto_reply_enabled` or
`auto_post_enabled`. Those switch the system from suggest-only to autonomous
publishing and stay a deliberate database change. Sending them is not an error —
they are simply ignored, so a caller cannot enable publishing by guessing a
field name.

Respond `{ "ok": true, "id": 101 }`, or a non-2xx with a message the console can
display. `ok: false` with a 200 means the action was understood but matched no
row — a stale id, usually.

---

## POST — drafting

```jsonc
{ "action": "ask_claude", "prompt": "Shorten this and drop the exclamation marks." }
```

### `run_optimizer`

```json
{ "action": "run_optimizer", "location_id": 1, "check_key": "service_descriptions" }
```

Omit `check_key` to work every outstanding check at once.

The second action that is not a plain database write. It calls the **GBP
Optimizer** workflow, which reads the open recommendations, generates what it
can honestly write, and files the result as a **draft**. It never sets a review
to `pending` and never submits a profile edit — `pending` is what publishes.

Returns `{ ok, action, generated, check_key, mode, reason, profile_edit_id,
reviews_drafted }`.

`generated` is the number of items written. When it is `0`, `mode` says why and
`reason` is the message to show:

| mode | meaning |
|---|---|
| `generated` | content was written and is waiting for approval |
| `ask` | the answer is a fact only the owner knows — opening hours, a booking URL, a price, a photograph. Nothing is generated |
| `blocked` | the fix cannot be published yet; posts are blocked pending appeal `0-8526000042027` |
| `none` | nothing outstanding for that check |

**A check that refuses is not a failure.** The optimizer will not publish
invented opening hours to buy back 0.72 points, and it will not point a booking
link at a homepage. It returns the question instead, and the console shows it.

The one action that is not a database write. It exists because the console is a
static page on GitHub Pages and **cannot hold the Anthropic key** — putting it in
the page source would publish it. The webhook already has the credential, so the
request is routed to `https://api.anthropic.com/v1/messages` behind the same
bearer auth as everything else.

Returns `{ "ok": true, "action": "ask_claude", "text": "…", "error": null }`.

**It drafts and nothing more.** The answer goes back to an editor for a human to
read, change and approve. Nothing is written to `gbp_reviews` or `gbp_posts` on
this path, and nothing reaches Google. The system prompt forbids inventing facts
about the business, because a plausible invented price or date in a published
reply is worse than a vague one.

The model sees only the prompt the console assembles — the current editor text,
if any, plus what the operator typed. No profile data, no reviews and no
database content are attached implicitly.

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

---

## POST — profile content

```jsonc
{ "action": "save_profile_edit", "location_id": 1,
  "description": "…", "services": [{ "display_name": "…", "description": "…" }],
  "note": "why" }
```

| action | effect |
|---|---|
| `save_profile_edit` | upsert the single **draft** for that location. A key that is absent leaves that part of the profile alone; a key present and empty clears it. Partial saves merge |
| `submit_profile_edit` | `location_id` — moves that draft to `pending` |
| `cancel_profile_edit` | `id` — withdraws a draft, pending or failed edit |

**Saving is not submitting.** They are separate actions so that nothing reaches
Google because a textarea lost focus.

`GBP Apply Profile Content` reads the `pending` rows, writes to Google, and
marks each `applied` or `failed`. Its guards are unchanged and load-bearing:

- `serviceItems` and `specialHours` are **replace-the-whole-list** on Google's
  side. The applier reads the live list, merges, and **refuses to write a merged
  list shorter than the existing one**.
- `specialHours` are untouched unless the edit supplies them, rather than an
  empty list being written over real holidays.
- A description over 750 characters fails the row with a readable reason instead
  of a 400 from Google.

Only a service's **name** is sent. The console stores the description typed
after `::` but does not write it, because the free-form service field shape is
unverified — the published docs were already wrong about `categoryId`, and
guessing a second field risks a silent failure on a live profile.

The console also reads `services` (the live list) and `profileEdits` (edits
still in play, failed ones included) from the GET payload.
