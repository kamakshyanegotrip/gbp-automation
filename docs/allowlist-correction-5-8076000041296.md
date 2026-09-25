# Allowlist correction — case 5-8076000041296

**Two things are being corrected in one message:**

1. The original request described a single business (Negotrip). The correct model
   is that **Assign Over is the software publisher** and Negotrip is its first
   client. Google's Business Profile API policies permit this third-party use.
2. The case was opened from `kn0733@gmail.com` while the declared website is
   `assignover.in`. Google's own quota page requires that *"your website domain
   matches your email domain when submitting the request form."* That mismatch
   is a documented delay trigger, and it is now fixable because
   `support@assignover.in` is a working mailbox.

**Do not open a second Cloud project.** Under the policies a client must not have
their own API project either — all access flows through
`gbp-automation-507508`.

---

## Volume framing — read this before you send

You said 50+ profiles within 12 months. Two facts shape how that should be
worded:

- Once **Basic API Access** is granted, the standard allocation is already
  **300 QPM** across the Business Profile APIs. Fifty profiles audited daily is
  roughly 900 calls per *day* — about 0.6 calls per minute. You do not need a
  quota increase; you need the access grant.
- Google's stated reason for refusing quota *increases* is usage below 50% of
  the current limit. Asking for more than default, with one live client and no
  usage history, adds risk and buys nothing.

So the message below states the ambition honestly **and explicitly declines to
ask for extra quota.** That is the strongest position: credible growth, zero
additional demand on the reviewer.

---

## The message to send

> Subject: Correction to our access request — third-party software provider,
> and corrected contact domain (case 5-8076000041296)
>
> Hello,
>
> I would like to correct and expand the description I gave in this request so
> that the record accurately reflects how our application works, and to correct
> the contact address.
>
> **1. Contact address.** This case was opened from a personal Gmail address.
> The correct contact, matching the website domain for this application, is
> **support@assignover.in**. Please update the case contact to that address.
>
> **2. Applicant.** My original submission described a single business,
> Negotrip. That was incomplete. **Assign Over is the software publisher and the
> sole owner of this Google Cloud project (`gbp-automation-507508`, project
> number `683796039477`).** Assign Over builds and operates a Business Profile
> management tool for its clients. Negotrip is our first client, not the
> applicant. Further client businesses will connect their own Business Profiles
> to the same application over time.
>
> Assign Over is a sole proprietorship firm owned by Kamakshya Prasad Nayak,
> registered at 58/90, Gangotree Nagar, Sishupalgarh, Bhubaneswar, Odisha
> 751002, India. Our website is https://assignover.in and the application
> described here is published at https://automation.assignover.in.
>
> **3. How access works.** Each client authorises us individually through
> Google's own OAuth consent screen, using their own Google account, with the
> `https://www.googleapis.com/auth/business.manage` scope. We never ask for, see
> or store a client's password, and we never sign in on their behalf — every
> authorisation is a manual action the client performs themselves on Google's
> screen. Clients do not have, and are not asked to create, their own Google
> Cloud projects or API credentials; all access is through this single project,
> as the policies require. A client can revoke us at any time at
> myaccount.google.com/permissions, without contacting us.
>
> **4. What the application does.** For each connected profile it reads the
> profile and produces a health assessment and prioritised recommendations for
> that client; it drafts replies to reviews and drafts local posts. It is
> approval-first: drafts are held and nothing is written back to Google until a
> person approves it. The only two things we ever write are a review reply and a
> local post. We do not display, redistribute or resell Google content to anyone
> other than the client whose profile it came from, and we never use it for
> advertising.
>
> **5. APIs we need.** Google My Business API v4 for reviews, local posts and
> media; My Business Business Information API v1 for business details,
> categories and attributes; My Business Account Management API v1 for account
> and location listing; Business Profile Performance API v1 for performance
> metrics.
>
> **6. Expected volume.** One client profile today (Negotrip), growing toward
> 50 or more client profiles over the next twelve months. Each profile is
> audited once daily, with review and post checks on the same schedule —
> approximately 18 API calls per profile per day, so under 1,000 calls per day
> even at fifty profiles. **This sits well inside the standard allocation and we
> are not requesting a quota increase**, only Basic API Access.
>
> **7. Caching.** Content received from Google is retained for no more than 30
> calendar days. This is enforced in code, not by policy alone: a scheduled
> daily job redacts every Google-sourced field from any record that has gone 30
> days without a refresh, clears stored API responses, and writes an audit row
> for each sweep so the sweep is verifiable.
>
> **8. Client transparency.** We notify a client within 48 hours of any change
> made to their profile through our tool. On termination we disconnect the
> account, revoke our tokens and delete stored data within seven business days,
> and confirm in writing.
>
> **Our public documentation:**
> - Application home page: https://automation.assignover.in/gbp/
> - Privacy policy, including the Limited Use disclosure:
>   https://automation.assignover.in/privacy/
> - Terms of service: https://automation.assignover.in/terms/
>
> The OAuth consent screen for this project is published under the name
> **Assign Over**, with `assignover.in` verified in Google Search Console as an
> authorised domain, and publishing status set to In production.
>
> Please let me know if you need anything further, including a demonstration of
> the application.
>
> Thank you,
> Kamakshya Prasad Nayak
> Assign Over — support@assignover.in

---

## Prepared answers to the likely follow-ups

| Question | Answer |
|---|---|
| Are you the business owner or a third party? | Third party. Assign Over is a software provider; the profiles belong to our clients. |
| Do your clients have their own API projects? | No. All access is through Assign Over's single project, as the policies require. |
| How do clients grant access? | Manually, on Google's OAuth consent screen, with their own Google account. We never handle their credentials. |
| Do you store Google data? | Yes, temporarily — no more than 30 calendar days, enforced by an automated daily redaction job with an audit log. |
| Do you write to profiles automatically? | Not by default. Approval-first; a person approves every reply and post. Clients may opt into automatic replies, and safety rules still hold low ratings, negative sentiment and legal/safety/refund mentions for a human. |
| Do you display Google content publicly? | No. Content is shown only to the client whose profile it came from, in reports and emails. |
| Do you sell or share Google data? | No, in any circumstance. |
| Scope justification | `business.manage` is the only scope that permits reading a profile's reviews, media, service items and business information and writing approved replies and posts. There is no narrower scope covering these. |
| How long has the profile been verified? | Negotrip's profile is verified and has been active well beyond the 60-day minimum. |

---

## After you send

- Watch the quota page — `requests per minute` moves from **0** to **300**:
  `console.cloud.google.com/apis/api/mybusinessbusinessinformation.googleapis.com/quotas?project=gbp-automation-507508`
- **Known gotcha:** approval can land per-API. Operators have reported the
  Business Profile API approved while **Account Management API quota stayed at
  0**, which blocks `accounts.list` and therefore blocks everything downstream.
  Check the quota page for *each* of the four APIs, not just one.
- Tell me when quota opens and I will fetch the real account and location IDs,
  replace the `accounts/PENDING` / `locations/PENDING` placeholders, and run the
  first live audit.

---

## If it is refused

Ranked by how much of the system survives:

1. **Fix and resubmit.** Denials state a reason and there is no cooling-off
   period. Most are mechanical.
2. **Narrow the ask** to read-only (Business Information + Performance), drop
   the v4 write endpoints. Keeps the entire audit and scoring engine.
3. **Places API.** No allowlist needed — an ordinary paid Maps Platform API.
   Gives name, address, hours, phone, website, category, photos, star rating,
   total review count and **up to 5 reviews**. Covers most of Business Info
   (25%) and Photos (20%) and the headline half of Reviews (20%). Cannot do
   performance metrics, service items, or any writing.
4. **Rent approved access** via an aggregator — Windsor.ai (already connected,
   with `google_my_business` read and write actions), Supermetrics, BrightLocal,
   Birdeye, Yext. Puts a vendor between you and client data, which the privacy
   policy would need to name.
5. **Assistant mode.** The drafting half never touches Google. Claude writes the
   copy; only reading the profile and publishing need the API. Client pastes
   reviews in or Places supplies them, a human pastes the reply back. Shippable
   without any grant.

**Not an option:** browser automation against business.google.com. It breaches
Google's terms and the account at risk is the client's profile.
