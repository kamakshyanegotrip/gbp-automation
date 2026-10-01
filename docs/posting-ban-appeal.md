# Appeal: posting disabled on the Negotrip Business Profile

## What happened

On **3 June 2026** Google emailed `kn0733@gmail.com`:

> "Negotrip, your post violates Google's content policy. **Google has turned off
> posting for this Business Profile** to prevent edits that violate Google's
> policies."
>
> Removed post: **RATH YATRA 2026 – Spiritual Journey to Puri**
> "Sacred Wheels, Eternal Memories. Walk with the sacre…"
>
> **Routing ID: DPNB**

The email sat unread until 20 September 2026, when the performance backfill
surfaced it. Posting has been off since 3 June — close to four months as of
1 October.

**The delay does not weaken the appeal and should not be explained in it.**
There is no deadline on a content restriction, and volunteering "I didn't read
your email for three months" invites a question nobody asked.

## Profile identifiers

| Field | Value |
|---|---|
| Business name | Negotrip |
| Account ID | `14183146380584509336` |
| Location fid | `964969879651510777` |
| Owner account | `kn0733@gmail.com` |
| Routing ID from the notice | `DPNB` |

---

## Where to appeal

**Appeals tool:** https://support.google.com/business/?p=manage_appeals
Decisions take **up to 5 business days**.

**Important regional limitation.** Google's own help page says the appeals tool
handles suspensions, rejected edits and media **for UK/EEA businesses**; for
other locations — India included — the tool covers **profile suspensions only**,
and other issues "require contacting support."

A content restriction is not a suspension. So expect one of two outcomes:

1. The tool accepts it — good, submit and wait.
2. The tool offers no option matching a content restriction — then go to
   **Business Profile support** (Help → Contact us from inside the Business
   Profile Manager, signed in as `kn0733@gmail.com`) and paste the same text,
   quoting Routing ID `DPNB`.

---

## Before you send: check the post yourself

I cannot see the removed post's full text — the notification truncates it. The
appeal is stronger if you know what actually tripped the filter. Google's local
posts policy most commonly catches:

- **Phone numbers or email addresses in the post body** (they belong in profile
  fields, not post text)
- **Prices or offers presented misleadingly**, or "limited time" pressure
- **Duplicate or near-duplicate posts** published repeatedly
- **Links to a site that doesn't match the business**
- Excessive capitalisation or promotional symbols

If the Rath Yatra post contained a phone number or a booking link to a domain
other than negotrip.in, say so honestly in the appeal and state that it has been
corrected. Admitting a specific fix lands far better than a blanket denial.

---

## Appeal text

> **Subject:** Appeal — posting disabled on Negotrip Business Profile (Routing ID: DPNB)
>
> Hello,
>
> I am the owner of the Negotrip Business Profile (account ID
> 14183146380584509336, location 964969879651510777) and I am appealing a
> content restriction.
>
> On 3 June 2026 I received a notification stating that a post violated Google's
> content policy and that **posting has been turned off for this Business
> Profile**. The Routing ID on that notice is **DPNB**. The post concerned was
> titled "RATH YATRA 2026 – Spiritual Journey to Puri".
>
> **About the business.** Negotrip is a travel company based in Bhubaneswar,
> Odisha, operating tour packages across Odisha and elsewhere in India. The
> profile is verified, has been active for several years and carries more than
> twenty customer reviews.
>
> **About the post.** It advertised a guided pilgrimage tour package to the
> Rath Yatra festival in Puri — a mainstream annual event and a standard product
> for a travel operator in this region. The content was directly related to the
> services this business provides. It did not concern restricted or regulated
> goods, contained no adult, offensive or misleading material, and made no claim
> the business cannot fulfil.
>
> **What I am asking.** I would be grateful if you could:
>
> 1. Reinstate posting on this Business Profile.
> 2. If the restriction stands, tell me the specific clause of the local posts
>    content policy that the post breached, so I can correct it rather than guess.
>
> I have re-read the Business Profile posts content policy and will follow it in
> future posts. I understand a further violation could lead to stronger action
> against the profile.
>
> Thank you for reviewing this.
>
> Kamakshya Prasad Nayak
> Owner, Negotrip
> kn0733@gmail.com

---

## After you send

- Expect up to **5 business days**.
- **Keep the case reference.** As with the API allowlist case, note whatever
  reference number the confirmation gives you — it is the only record.
- Google replies to the account email. Check `kn0733@gmail.com`, including spam.

## Why this matters to the automation

Until posting is reinstated, the content half of the system cannot work **no
matter which access route you take**:

- Google Business Profile API — blocked by the restriction, not just the quota
- Windsor.ai `create_local_post` and `upload_media` — same restriction applies,
  since it acts on the same profile
- Manual posting in Business Profile Manager — also blocked

So `GBP Content Management` stays inactive and queued photos stay queued until
this is resolved. Reviews are unaffected: replying to reviews is a separate
permission and continues to work.
