# GBP Automation

Google Business Profile automation for multiple client profiles, built on n8n and
Postgres, with a static operations console.

**Publisher:** Assign Over · **Status:** two profiles live, suggest-only

---

## What this is

Automation that audits Google Business Profiles, scores their health, drafts
review replies and posts, and holds everything for human approval. It does not
publish anything on its own — `auto_reply_enabled` and `auto_post_enabled` are
both false, by design.

| Part | Where it runs |
|---|---|
| Workflows | n8n |
| Data | Postgres (Neon) |
| Console | this repo, served as a static page |

---

## The console

A single static page: health scores by dimension, score trend, open
recommendations, the approval queue, and a per-client report view.

**It contains no data.** It fetches everything at runtime from one
bearer-authenticated n8n webhook. Open it with no endpoint configured and it
runs on clearly-labelled sample data instead, so the deployed page is useful to
look at without exposing anything real.

### Running it

Any static host works — it has no build step and no dependencies.

```bash
python3 -m http.server 8080    # then open http://localhost:8080
```

To connect it to live data, click **Demo data** in the header and enter the
webhook URL and token. Both are kept in that browser only.

If the n8n side is not set up yet, open **`setup.html`** instead. It walks
through generating the token, creating the Header Auth credential, attaching it
to both webhook nodes *before* activating the workflow, and then tests the
connection — reporting what specifically failed rather than just "error" — and
writes the endpoint and token for the console on success.

### Deploying to GitHub Pages

Settings → Pages → Source: *Deploy from a branch* → `main` / `/ (root)`.

**Read [`api/CONTRACT.md`](api/CONTRACT.md) before you do.** Pages is public on
every plan below Enterprise — including Pages served from a private repo. That
is why the page holds no data, and why it must stay that way.

---

## Repository layout

```
index.html           the console
setup.html           four-step wizard for connecting it to n8n
assets/              its stylesheet and script — no dependencies, no build
api/CONTRACT.md      the JSON contract the n8n webhook must satisfy
migrations/          Postgres schema, 001 → 011, run in order
workflows/           workflow generators and the shared error handler
docs/                status notes, appeals, profile content
```

---

## Database

Twelve migrations, applied in numeric order. The ones worth knowing:

| Migration | Why it exists |
|---|---|
| `005` | The four views the console reads |
| `008` | 30-day retention. **Redacts rather than deletes** — Google-sourced fields are stripped after 30 days without a refresh, while derived numbers survive so score history stays intact |
| `009` | Email-sourced reviews. Notification emails carry the real `google_review_id`, so these rows reconcile with API rows instead of duplicating them |
| `010` | Monthly performance, kept separate from the daily API-shaped table — writing a monthly total into a daily row would read as one enormous day |
| `011` | The client layer for multi-tenant |

---

## Health scoring

Weights total 100 and are enforced in the schema:

| Dimension | Weight |
|---|---|
| Business Info | 25% |
| Photos | 20% |
| Reviews | 20% |
| Profile | 15% |
| Content | 10% |
| Services | 10% |

---

## Things learned the hard way

Kept because each one cost real time.

**Google's API docs are wrong about service items.** They document `categoryId`
on `freeFormServiceItem`; the live API uses `category`, holding the full
resource name (`categories/gcid:tour_operator`).

**`serviceItems` and `specialHours` are replace-the-whole-list.** There is no
partial update. A patch must read the existing list and carry it forward or it
silently deletes everything not resent — and whatever is being merged has to be
in the `readMask`, or the merge has nothing to read.

**A node that outputs zero items halts the chain.** Any query that can
legitimately return no rows needs *Always Output Data*.

**A Postgres node runs once per input item.** If the query does not depend on the
item, set *Execute Once* or it multiplies everything downstream.

**Code node return shape depends on mode.** *Run Once for All Items* returns an
array; *Run Once for Each Item* returns a bare `{json: …}`.

**`URL` is not available in the n8n Code sandbox.** Parse with regex — and never
let a `catch` swallow the failure of a security check. A link allow-list once
rejected every URL including valid ones, silently, for weeks.

**`RETURNING` only sees the row you inserted.** Wrap the INSERT in a CTE and join
to carry other columns forward.

---

## Security

- No credentials in this repository. Every file was scanned before the first
  commit.
- The console stores its endpoint and token in `localStorage`, which is readable
  by anyone with access to that browser profile. Use a token scoped to the
  console and rotate it if the machine is shared.
- The webhook must have Header Auth attached **before** the workflow is
  activated. An active webhook without it is an unauthenticated read of the
  whole database.
- The console cannot delete anything, and cannot switch on autonomous
  publishing. Both are deliberate.
