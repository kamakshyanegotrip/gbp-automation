# Chasing the GBP API allowlist — case 5-4868000041887

**Status at 1 October 2026:** 23 days past Google's own estimate, no reply in
either mailbox, quota page still reads requests-per-minute **0**.

| Field | Value |
|---|---|
| Case | `5-4868000041887` |
| Submitted | 8 September 2026, via the guided allowlist wizard |
| Stated review time | 7–10 business days, so ≈ 17–22 September |
| Cloud project | `gbp-automation-507508`, project number `683796039477` |
| Contact on the case | `support@assignover.in` |
| Publisher | Assign Over, third-party software publisher |
| First client | Negotrip |

---

## Read this before sending anything

**Do not submit a new request.** An earlier case, `5-8076000041296`, was filed,
never acknowledged, never appeared in the account's support history, and was
eventually treated as never filed. Filing a second request is how that happened
and how months were lost. Quote `5-4868000041887` and chase it.

**There may be no email thread to reply to.** Both mailboxes were searched,
spam included, and nothing came back — so the case may never have produced an
acknowledgement either. If that is so, this is the same failure as last time and
the useful thing to establish is not "please hurry" but **does Google have a
record of this case at all**. The text below asks that first, because the answer
changes what to do next.

**Check the quota page before sending.** If it now reads 300 the case is moot:

```
console.cloud.google.com/apis/api/mybusinessbusinessinformation.googleapis.com/quotas?project=gbp-automation-507508
```

---

## Where to send it

1. **If an acknowledgement email exists** for `5-4868000041887` in either
   mailbox — reply to it directly. A reply on the thread is the strongest route
   because it reaches the same queue.
2. **If no acknowledgement exists** — go to Google Cloud Console → **Support**
   → **Cases**, signed in to `gbp-automation-507508`, and look for the case
   there. If it is listed, add a comment. If it is not listed, that is itself
   the finding, and it matches what happened to `5-8076000041296`.
3. **If it appears nowhere** — the allowlist form is the only route left, and at
   that point a resubmission is justified rather than duplicative. Say in it
   that `5-4868000041887` was submitted on 8 September and cannot be located.

---

## The text

> **Subject:** Follow-up — GBP API allowlist, case 5-4868000041887 (project gbp-automation-507508)
>
> Hello,
>
> I am following up on case **5-4868000041887**, an allowlist request for the
> Google Business Profile APIs on Cloud project `gbp-automation-507508`
> (project number 683796039477), submitted on **8 September 2026**.
>
> The acknowledgement stated a review time of 7 to 10 business days. That
> window closed around 22 September. I have had no response at either address
> associated with the request, and the quota page for
> `mybusinessbusinessinformation.googleapis.com` still shows requests per
> minute as 0.
>
> Could you confirm two things:
>
> 1. That case 5-4868000041887 is on record and still open. An earlier request
>    from this account produced no acknowledgement and does not appear in the
>    support history, so I would like to be certain this one was received
>    rather than assume it.
> 2. Whether anything further is required from me. If the application is
>    incomplete or the declaration needs correcting, I would rather fix it than
>    continue waiting.
>
> For context: Assign Over is the software publisher and holds the Cloud
> project, the OAuth client and this request. Negotrip is the first client
> profile, and each client connects their own profile through our consent
> screen. The OAuth consent screen is in production, the domain
> `assignover.in` is verified in Search Console, and the privacy policy and
> terms are published, including the 30-day limited-use term.
>
> Thank you,
>
> Kamakshya Prasad Nayak
> Assign Over
> support@assignover.in

---

## Afterwards

Record what happens on the `gbp_appeals` row for this case — it is already
there, `case_kind = 'api_allowlist'`, and the console shows it as overdue.

- A reply arrives → set `responded_at`, and `outcome` once decided.
- Granted → `outcome = 'granted'`, `status = 'closed'`, and the Phase 2 work in
  *Status & Remaining Work* unblocks: real account and location IDs replace the
  `PENDING` placeholders, then the first live audit.
- No record of the case → `outcome = 'unanswered'` and close it, then file
  fresh. That value exists precisely for this outcome.
