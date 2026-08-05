# RUNBOOK — Safety & Trust

What to do when a person is at risk, or a person is the risk. Written 2026-08-04.

**This marketplace puts strangers in physical proximity, and some users are
students.** Safety reports outrank every other queue, including money.

**Escalation contact:** whoever holds the `SAFETY_ONCALL_EMAIL` inbox.
**Target response: 1 hour** for §1 and §2. Everything else, same day.

> If someone is in immediate danger, tell them to call **911** first. We are not an
> emergency service and must never position ourselves as one.

---

## 0. Where things live

| Thing | Where |
|---|---|
| Moderation queue | `/moderation` — open vs resolved; `auto` pill = machine-filed |
| A report's context | the report row links to `/bookings/<id>` ("view conversation") or `/users/<id>` |
| A person | `/users/<id>` — profile, bookings both sides, reports, notes, login history |
| Support tickets | `/support` — in-app tickets now land here (mobile + web) |
| Blocks | bottom of `/moderation` |

**How a report reaches you.** `reports` INSERT → `trg_notify_safety_report` → pg_net →
`safety-alert` edge function → Resend → the on-call inbox. Machine-filed rows carry
`source = 'auto'` and are excluded from the alerting filter and from settlement gating.

---

## 1. Safety report on an in-person gig

1. Open the alert email → it deep-links to the report.
2. **Establish whether it is happening now.** Check the booking's `started_at` and
   the slot time on `/bookings/<id>`. An in-progress gig is the urgent case.
3. Read the conversation on `/bookings/<id>` — it renders the full thread with
   signed chat images.
4. Contact the reporter: `/users/<id>` → **Notify user**. Acknowledge, say what
   you're doing, and give them the 911 line if there is any physical risk.
5. Act on the reported party:
   - Credible physical-safety risk → **Suspend** immediately (`/users/<id>`).
     Reason field is mandatory in practice — write a real one; it is what a later
     appeal or a subpoena is judged against. Suspension = GoTrue `banned_until` +
     `profiles.suspended_at`, and revokes their sessions.
     - Their existing access token stays valid for up to **~1h**. Supabase cannot
       kill a live JWT. If that window matters, say so internally — do not tell the
       reporter they are instantly gone.
   - Unclear → leave the report **open**, add an `admin_user_notes` entry, and
     revisit within the day.
6. Resolve the report (`/moderation`) with a resolution string that a stranger could
   read and understand. **Only `admin` role can resolve** — a `support` helper can
   read the queue but not clear it.

> **An unresolved report blocks the earner's payout** (`earner-claim-payment` refuses
> on any open non-auto report). Leaving a report open is not free — it withholds
> someone's wages. Resolve it or escalate it; don't let it sit.

---

## 2. Harassment / abusive messages

1. From the report, follow "view conversation" to `/bookings/<id>`.
2. **If the report is profile-level, there is no evidence path.** `submitReport`
   files profile reports with no `booking_id`, and there is no message search. You
   will have to find a shared booking by opening both `/users/<id>` pages and
   comparing. This is a known gap (`ADMIN_AUDIT_2026-08-04.md` §4).
3. There is **no way to redact a single message or review**. The only content
   remedies are suspending the account or deleting it entirely. Choose proportionally;
   do not delete an account to remove one message.
4. Blocks are bidirectional and silent — the blocked user is never told. Preserve
   that: never reveal to someone that they were blocked.

---

## 3. Underage account (below the age floor)

The DB enforces an age floor at signup (`20260710040000_age_floor.sql`,
hardened in `..._40000`), with `date_of_birth` pinned once set.

If an under-age account is discovered anyway:

1. **Suspend immediately.** Reason: `age floor`.
2. Cancel any live bookings — `/bookings/<id>` → Intervene → **Force cancel**. It
   releases the escrow hold first and refuses to proceed if that release fails, so a
   cancelled booking never strands a live authorization. Message both parties.
3. **Delete the account** (`/users/<id>` → type `DELETE`). Deletion refuses while
   escrow is unsettled — settle or void the hold first.
4. Record what was found and when, in `admin_user_notes` **before** deleting — the
   profile row and its context are gone afterwards. The `admin_audit_log` entry is
   written before the cascade and survives.

---

## 4. Illegal content (CSAM, threats, weapons)

1. **Do not download it. Do not forward it.**
2. Suspend the account immediately.
3. Preserve evidence: record the `booking_id`, `message.id`, and storage path in
   `admin_user_notes`. **Do not delete the account yet** — deletion destroys the
   storage objects you may be legally required to preserve.
4. For suspected CSAM: report to **NCMEC** (`report.cybertip.org`). This is a legal
   obligation in the US, not a judgment call. Escalate to the founder the same hour.
5. Wait for instruction before deleting anything.

---

## 5. Law-enforcement request

1. Do not act on an emailed request alone. Verify it is a valid subpoena/warrant and
   note the issuing agency and case number.
2. What we can produce today: the per-user JSON export
   (`/users/<id>/export`), plus screenshots of `/bookings/<id>`. There is no booking
   case packet and no `data_requests` log — build the record by hand in
   `admin_user_notes`.
3. `admin_audit_log` is append-only (UPDATE/DELETE revoked even from `service_role`),
   so every access you make is itself on the record. That is a feature — it is what
   demonstrates the access was authorized.

---

## 6. Auto-moderation flooding the queue

Rows with `source = 'auto'` come from the keyword/image moderation layer. They are
excluded from the earner-payout gate and from the safety pager, so they are noise, not
alarms. Triage them in a batch, not one at a time.

If a term is producing constant false positives, edit the list in
`shared/contentFilter.js` and the corresponding migration rather than resolving the
same report shape forever.

> `moderate-text` **fails open** on outage — content passes through unchecked, silently.
> `/flags` does NOT cover this: there is no `moderation_enabled` switch, because failing
> closed would block all posting and messaging outright. The blunt instrument today is
> to pause `posting_enabled` and rely on the client-side blocklist in
> `shared/contentFilter.js`, which runs regardless. A real fail-closed mode is not built.

---

## 7. What the console still cannot do

- No message or review redaction — suspend or delete only.
- No profile-level report → evidence path.
- (Since 2026-08-04 it **can** pause signups, posting, payments, tips and the AI
  assistant from `/flags`, close the beta from `/access`, and force-cancel a booking
  from `/bookings/<id>` — useful when a safety case needs a gig stopped now.)
- No verification review queue: ID (`id_verification_status`) and student status are
  fully automated. `setVerified` is a boolean with no reason and no evidence, and it
  drives a badge other users act on **in person**. Use it sparingly and note why.
- No "view as user", so you cannot reproduce what a user is actually seeing.
- No announcement/broadcast — you can only notify one account at a time.
