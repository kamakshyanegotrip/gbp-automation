# Basic API Access — form fill sheet

**Form:** https://support.google.com/business/contact/api_default

## What I found

Two independent signals say your original request never landed:

1. No acknowledgment email anywhere in `kn0733@gmail.com`.
2. The form's own *"Use past details"* widget — which reads your Google support
   case history for the signed-in account — returns **"No matching past cases
   found."** Chrome is signed in as `kn0733@gmail.com`, so it looked in the
   right place.

Neither is proof on its own, but together they point one way. Treat this as a
**fresh submission** that mentions the old case number, rather than a follow-up.

## The sign-in trap, and how it resolves the domain problem

The form says: *"you must be signed in to the Google Account associated with
your Business Profile."* That means **stay signed in as `kn0733@gmail.com`** —
it is the owner of Negotrip's profile.

But the **Email address field is separate from the signed-in account.** Put
`support@assignover.in` there. That satisfies Google's documented requirement
that the contact email domain match the website domain, without breaking the
profile-ownership requirement. Both conditions met at once.

---

## Field by field

| Field | Value |
|---|---|
| What can we help with? | **Application For Basic API Access** |
| Confirmation checkbox | Tick it |
| What is your name? | `Kamakshya Prasad Nayak` |
| Email address | `support@assignover.in` |
| Company Name | `Assign Over` |
| Google Cloud Platform Project ID | `gbp-automation-507508` |
| Google Cloud Platform Project Number | `683796039477` |
| API dropdown, if one appears | `GBP API v4.9` |
| Issue Summary | see below |
| Issue Description | see below |
| Attachment | leave empty |

### Issue Summary

```
Basic API Access for Assign Over, a third-party Business Profile management tool (re: earlier case 5-8076000041296)
```

### Issue Description

```
Assign Over is the software publisher and sole owner of Google Cloud project
gbp-automation-507508 (project number 683796039477). We build and operate a
Business Profile management tool for our clients.

An earlier request under case 5-8076000041296 described a single business,
Negotrip. That was incomplete: Negotrip is our first client, not the applicant.
This submission corrects the record. That earlier case has produced no
acknowledgement and does not appear in our support history, so we are
resubmitting rather than following up.

Assign Over is a sole proprietorship firm owned by Kamakshya Prasad Nayak,
registered at 58/90, Gangotree Nagar, Sishupalgarh, Bhubaneswar, Odisha 751002,
India. Our website is https://assignover.in and the application described here
is published at https://automation.assignover.in.

HOW ACCESS WORKS
Each client authorises us individually through Google's OAuth consent screen,
using their own Google account, with the scope
https://www.googleapis.com/auth/business.manage. We never ask for, see or store
a client's password, and we never sign in on their behalf; every authorisation
is a manual action the client performs on Google's own screen. Clients do not
have, and are not asked to create, their own Google Cloud projects or API
credentials. All access is through this single project, as the policies
require. A client can revoke us at any time at
myaccount.google.com/permissions without contacting us.

WHAT THE APPLICATION DOES
For each connected profile it reads the profile and produces a health
assessment and prioritised recommendations for that client; it drafts replies
to reviews and drafts local posts. It is approval-first: drafts are held and
nothing is written back to Google until a person approves it. The only two
things we ever write are a review reply and a local post. We do not display,
redistribute or resell Google content to anyone other than the client whose
profile it came from, and we never use it for advertising.

APIS REQUESTED
Google My Business API v4.9 for reviews, local posts and media; My Business
Business Information API v1 for business details, categories and attributes; My
Business Account Management API v1 for account and location listing; Business
Profile Performance API v1 for performance metrics.

EXPECTED VOLUME
One client profile today (Negotrip), growing toward 50 or more client profiles
over the next twelve months. Each profile is audited once daily, with review
and post checks on the same schedule: approximately 18 API calls per profile
per day, so under 1,000 calls per day even at fifty profiles. This sits well
inside the standard allocation and we are not requesting a quota increase, only
Basic API Access.

CACHING
Content received from Google is retained for no more than 30 calendar days.
This is enforced in code, not by policy alone: a scheduled daily job redacts
every Google-sourced field from any record that has gone 30 days without a
refresh, clears stored API responses, and writes an audit row for each sweep so
the sweep is verifiable.

CLIENT TRANSPARENCY
We notify a client within 48 hours of any change made to their profile through
our tool. On termination we disconnect the account, revoke our tokens and
delete stored data within seven business days, and confirm in writing.

PUBLIC DOCUMENTATION
Application home page: https://automation.assignover.in/gbp/
Privacy policy, including the Limited Use disclosure:
https://automation.assignover.in/privacy/
Terms of service: https://automation.assignover.in/terms/

The OAuth consent screen for this project is published under the name
"Assign Over", with assignover.in verified in Google Search Console as an
authorised domain, and publishing status set to In production.

We are happy to provide a demonstration of the application on request.
```

---

## Before you hit Submit

- Confirm the browser is signed in as **kn0733@gmail.com**, not one of the other
  accounts on this machine.
- Confirm the Email address field reads **support@assignover.in**, not the Gmail.
- Screenshot the confirmation page. If it shows a new case number, save it —
  that is the only record you will get.

## After

Watch the quota page. `requests per minute` moves from 0 to 300 when granted:
`console.cloud.google.com/apis/api/mybusinessbusinessinformation.googleapis.com/quotas?project=gbp-automation-507508`

Check **each** of the four APIs, not just one. Approval has been reported to
land per-API, with Account Management stuck at 0 — which blocks `accounts.list`
and therefore blocks everything downstream.
