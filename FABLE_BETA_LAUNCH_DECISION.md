# FABLE_BETA_LAUNCH_DECISION.md

*Beta go/no-go decision for GoHustlr at commit `a70c9b5`. Based on [FABLE_BETA_AUDIT_REPORT.md](FABLE_BETA_AUDIT_REPORT.md), [FABLE_SECURITY_PRIVACY_REVIEW.md](FABLE_SECURITY_PRIVACY_REVIEW.md), and [FABLE_MARKETPLACE_ABUSE_REVIEW.md](FABLE_MARKETPLACE_ABUSE_REVIEW.md). Remediation sequencing is in [FABLE_FIX_PLAN.md](FABLE_FIX_PLAN.md).*

---

## Verdict: **Default NO-GO → flips to GO on attached evidence**

Status is **NO-GO by default.** It flips to **GO** when every item on the two checklists below carries attached evidence (re-runnable script output, dashboard export, or a dry-run record — with a date and a named owner). **No re-litigation on green:** once an item has valid, fresh evidence, it is done. Nothing here is a value judgment about the product — it is a small, finite, mostly cheap set of specific gaps plus a demand to *prove the hardening you already wrote is actually live.*

**Why not a flat GO:** the money/authorization/data-isolation core is verified sound *in source*, but (a) every DB-layer assurance is conditional on the tracked migrations being fully applied live and the Stripe webhook being live-registered — checkable, not yet checked; and (b) a handful of safety/privacy/fairness gaps would be indefensible to ship knowingly.

**Why not a flat NO-GO:** the blocking set is small, well-scoped, and mostly a few days of engineering plus dashboard config and legal paperwork. The epistemic gate is *not* stuck — you have a linked CLI and dashboard access, so "unverifiable from repo" becomes "verified on date X" the moment you run the introspection.

**Scope of this decision:** a **small, genuinely closed, invite-only** beta. That qualifier is load-bearing — most deferred risks are priced on the cohort being small and vetted, which is why "make the beta actually closed" is itself a blocking item (BL-1).

---

## How to read the checklists

Two kinds of items, because "auto-flip to GO" only works when the evidence is unambiguous:

- **One-time evidence items** — a script output, a dashboard screenshot, a passing test. These auto-flip when the artifact is attached and fresh.
- **Standing operational commitments** — "human-review every gig," "on-call answers safety reports." These are not checkbox-able; the evidence is a **written runbook with a named owner and a completed dry-run.** The runbook's existence + dry-run is the artifact.

**Evidence rules:** prefer re-runnable scripts over screenshots (dashboard state drifts); nothing older than 7 days at flip time; re-run after any migration or dashboard change. Store the artifacts in-repo (e.g. `audit-evidence/`).

---

## Checklist 1 — Must fix in code before ANY external user

| ID | Item | Evidence to attach | Report |
|---|---|---|---|
| **BL-1** | **Make the beta actually closed.** Server-side invite/allowlist gate on signup (or public signups disabled + admin-provisioned users). App-distribution and dashboard settings do **not** count — gohustlr.com has open signup. This is the only acceptable evidence. | A non-invited email's signup is rejected server-side (recorded request/response). | Security §2 |
| **BL-2** | **Block that blocks.** Fix the false "they can't reach you here" copy **now**; enforce block bidirectionally at `messages_insert` (minimum) and booking insert. | Copy diff; a blocked user's message/booking insert is denied (integration check). | Abuse A1 |
| **BL-3** | **Safety reports reach a human.** Insert trigger → email/push to a named on-call owner; confirm suspend/cancel/takedown tooling works end-to-end. | A test report fires an alert; enforcement dry-run recorded. | Abuse A2 |
| **BL-4** | **Guarantee completed work gets paid.** Auto-advance/earner-escalation when the poster is unresponsive N days after `earner_done` + slot passed (not just post-`completed`); capture at mutual completion (use payout `delay_days` as the dispute window); hold-expiry alerting; an open dispute suppresses auto-capture. | Design note + integration test of the ghosting and long-lead cases. | Abuse B1 |
| **BL-5** | **Age floor.** Collect DOB at signup; enforce ≥18 at action time (post/book/message), not `NOT NULL` (don't brick existing testers). | A <18 DOB is blocked from posting/booking (recorded). | Security §5 |
| **BL-6** | **Close the anonymous scrape.** In order: (1) BL-1 gate → (2) revoke `anon` SELECT on `profiles` and `jobs` → (3) reduce the cross-user column set. First fix the `skill_rates` missing-DDL so the lockdown migration can't abort on rebuild. Check gohustlr.com has no pre-auth job/profile render (or add a reduced-column server route). | `curl` with the anon key returns 0 rows/columns for `profiles`/`jobs`; rebuild-from-scratch applies the lockdown without aborting. | Security §3, §7 |
| **BL-7** | **Prohibited-use minimum.** Add academic-dishonesty/alcohol/drugs/weapons/off-platform-payment terms to all three moderation copies; **feature-flag the assistant off for beta** (cheapest compliant path — drops building a refusal layer to fast-follow); commit to human-reviewing every posted gig. | Term-list diff; assistant-disabled flag; gig-review runbook + owner. | Abuse A3 |
| **BL-8** | **Certificates bucket private** + `completion-photos` path guard. | Bucket `public=false` + signed-URL read; path-guard trigger present; anon read denied. | Security §4 |

*BL-2's copy fix and BL-8 are minutes-to-hours. BL-1, BL-4, BL-5, BL-6 are the real engineering (days). BL-3 and BL-7 are code + a runbook.*

---

## Checklist 2 — Config / operational / deploy-verification (evidence flips NO-GO → GO)

### 2a. Live-DB & payments verification (closes the epistemic gate)

| ID | Item | Evidence |
|---|---|---|
| **V-1** | Live `pg_policies`, column grants, triggers, and functions match the tracked hardened set (run an introspection `audit.sql` or `supabase db diff --linked`). **Anon has no SELECT on `profiles`/`jobs`.** | Saved script output. |
| **V-2** | Stripe webhook registered in the **target mode** with the correct signing secret, for **all** events (payment_intent.*, account.updated, identity.*, and — recommended — charge.dispute.created alert). *Highest-leverage single item: if stale, payments charge but earnings never credit.* | Dashboard export + a test event that credits earnings once. |
| **V-3** | Stripe **live** keys set in every prod env (edge functions + Vercel `NEXT_PUBLIC_*`); no silent `pk_test` fallback. | Env inventory + a live-mode smoke charge. |
| **V-4** | New Connect accounts: payout `delay_days ≥ 7` + manual first-payout review. | Dashboard config export. |
| **V-5** | Stripe Radar rules on; Connect + Identity enabled live. | Dashboard export. |
| **V-6** | Backups / PITR enabled (ideally restore-tested) — you hold money-state in Postgres. | Dashboard export / restore-test record. |
| **V-7** | Money-path smoke test passes against Stripe test mode: post→book→accept→done×2→verify→capture→credit once, + partial-capture, + cancel-release. | Test run log. |
| **V-8** | Realtime authorization enabled + RLS-gated; a cross-user channel subscription is denied. Re-test `MessageSheet` after enabling. | Subscription-denial record. |
| **V-9** | Supabase Auth: `mailer_autoconfirm=false`, HIBP on, OTP expiry sane, redirect allowlist correct, admin MFA enrolled. | Dashboard export. |
| **V-10** | Anthropic API key rotated (the previously-exposed one); no secret in any `NEXT_PUBLIC_*`. | Rotation record; secret-scan output. |

### 2b. Operational commitments (runbook + named owner + dry-run)

| ID | Item | Evidence |
|---|---|---|
| **O-1** | **Money-incident runbook** — refund, transfer reversal, pause payouts via the Stripe dashboard (the console has no such tooling). | Runbook + one dry-run. |
| **O-2** | **Safety incident-response + data-preservation runbook** — who responds, escalation, message/booking preservation, law-enforcement contact. | Runbook + owner. |
| **O-3** | **Hold-expiry monitoring + manual-capture procedure** (interim to BL-4). | Runbook + owner. |
| **O-4** | **Gig review** — every posted gig human-reviewed during beta (compensates BL-7's keyword limits). | Runbook + owner. |
| **O-5** | **Monitoring** — at minimum a Sentry DSN wired for crash/error visibility (analytics is currently null → blind beta). | DSN configured; a test error visible. |

### 2c. Non-engineering blockers (carried from the prior audit, still open)

| ID | Item | Status |
|---|---|---|
| **L-1** | **Business entity (LLC)** formed. *Genuinely blocking — a safety or payment incident with no entity lands on the founder personally.* | Open |
| **L-2** | **ToS / Privacy / Independent Contractor Agreement** attorney-reviewed; the `[DRAFT PLACEHOLDER]` arbitration clause resolved; a prohibited-use policy added. Publish the new `legal_documents` version **before** invites (it force-gates every user through consent). | Open |
| **L-3** | **Insurance** — start binding now; not a hard block for a ~20-person beta, but *bound before week 3 or pause invites.* | Open |
| **L-4** | Native push build (Expo Go can't receive remote push); App Store/Play prerequisites incl. privacy labels reflecting the now-private buckets. | Open |
| **L-5** | Operational config: Resend verified domain + `STUDENT_VERIFY_FROM`; `gohustlr.com` DNS → Vercel; Connect branding. | Open |

---

## Explicitly accepted risks for a *verified*-closed beta (fix before OPEN)

Recorded as decisions, not oversights, each priced on BL-1 being real:

- **No poster/booker ID verification; no background checks; students travel to strangers' addresses.** Accepted for a small vetted cohort with the safety runbook (O-2) and report alerting (BL-3) in place. Revisit before OPEN.
- **No chargeback auto-reversal** (alert-only handler acceptable at beta volume with V-4 payout delay + manual monitoring).
- **No collusion/Sybil detection, no velocity/reserve** — the invite gate (BL-1) is the beta control.
- **No dispute adjudication/appeal path** — disputes are terminal partial-capture rows; remediation is manual via O-1.
- **No e2e test suite** — the money-path smoke (V-7) is the beta bar.
- **Assistant cost-cap fails open; CCPA self-serve export absent** — bounded; document the data-access process in the Privacy Policy.

---

## The single most likely harms, and whether they're addressed

1. **A student does the work and never gets paid** — highest probability. Addressed by **BL-4** (+ O-3 interim). *This is the one to not get wrong.*
2. **An in-person safety incident** — lower probability, highest severity. Discovery is mitigated (BL-1/BL-6 scrape closure, BL-3 alerting, BL-2 block); residual physical risk is **explicitly accepted** for a vetted cohort with runbooks. Revisit before OPEN.
3. **Founder personal liability** — addressed only by **L-1** (entity). Blocking.

---

## If you do nothing else, do these three

1. **Make the closed beta real** — ship the server-side invite gate (BL-1) and the `anon` revoke (BL-6), *in that order*, because every deferred risk is priced on the cohort actually being closed.
2. **Guarantee completed work gets paid** — capture at mutual completion with an earner-escalation path for the silent-poster case and hold-expiry alerting (BL-4), because "student worked, hold expired, can't be paid" is the most probable and most reputation-fatal event in this beta.
3. **Close the safety loop** — a block that actually blocks (BL-2), safety reports that page a human (BL-3), and an LLC between an incident and your personal assets (L-1).

Everything else on the checklists matters, but those three are where knowingly shipping without them would be indefensible in three months.
