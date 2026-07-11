# FABLE_FIX_PLAN.md

> **✅ RESOLVED — Phase 1 (2026-07-11).** All Phase-1 code blockers (**H1–H8**) are implemented, tested, and **deployed** — Supabase migrations applied (`supabase db push`), edge functions deployed, web live on Vercel. The `skill_rates` DDL prereq, anon-revoke, block enforcement, age floor, safety-alert wiring, and moderation expansion all shipped. Phases 2–4 (config/verify/ops, fast-follow, before-OPEN) remain per below. Evidence: [FABLE_BETA_AUDIT_REPORT.md §4.1.1](FABLE_BETA_AUDIT_REPORT.md).

*Prioritized, sequenced remediation for GoHustlr at commit `a70c9b5`. Pairs with [FABLE_BETA_LAUNCH_DECISION.md](FABLE_BETA_LAUNCH_DECISION.md) (the checklist) and the topical reports (the evidence). This is a plan, not applied changes — no code was modified.*

**How to use this:** the launch decision defines *what* must be true; this defines *how*, *in what order*, and *what will bite you if you do it out of order*. Effort is rough (S ≤ half day, M ≈ 1–2 days, L ≈ 3–5 days). Owner column left blank to assign.

---

## 0. Order-of-operations traps (read first)

These are the sequencing landmines. Doing the right fix in the wrong order creates a new outage or leaves a hole open.

1. **Invite gate → anon revoke → column cut** (BL-1 → BL-6). Anon-revoke alone just adds a free signup step for a scraper; the gate alone leaves the anon feed open. Do them together, in order.
2. **Before revoking anon SELECT, check gohustlr.com's pre-auth pages.** If any marketing/SEO/OG-preview page renders jobs or profiles unauthenticated, it goes blank the moment you revoke — it needs a service-role server route exposing a reduced-column view first.
3. **Fix `skill_rates` DDL BEFORE running any live-DB introspection (V-1).** Otherwise your evidence documents a broken state and you re-run everything. The missing `ADD COLUMN` can also abort the column-lockdown migration on a fresh rebuild, silently *un-fixing* BL-6.
4. **DOB: nullable column → collect at next login → enforce at action time.** A `NOT NULL` DOB or a signup-only gate bricks existing testers who have no DOB.
5. **Auto-capture must yield to disputes.** BL-4's timeout must idempotently check for an open problem-report/dispute and skip; partial-capture wins. Remember the ~7-day *authorization*-expiry ceiling — prefer capturing at completion over delaying capture.
6. **Publish the new ToS version (L-2) BEFORE invites go out**, not mid-week-1 — a new `legal_documents` row force-gates every user through consent.
7. **If BL-1 is implemented by disabling public signups, build the invite/admin-provisioning path first**, or you brick your own onboarding.
8. **Realtime RLS flip (V-8) can silently kill legitimate chat channels** — test `MessageSheet` immediately after enabling.
9. **Native push rebuild changes the distributed binary (L-4)** — build before inviting testers, or everyone reinstalls.

---

## 1. Phase 1 — Blocking, in code (before ANY external user)

Ordered by dependency, then by "most-likely-harm-first."

| Order | Item | Finding(s) | Effort | Notes |
|---|---|---|---|---|
| 1 | **Invite/allowlist gate on signup** (server-side: signup trigger or edge function checking an allowlist, or disable public signups + admin-provision). | `beta-not-actually-closed` | M | The only acceptable evidence is a server-side rejection. Load-bearing for everything deferred. |
| 2 | **`skill_rates` / `stripe_identity_session_id` DDL** — tracked `add column if not exists` migrations ordered *before* the column-lockdown. | `skill-rates-no-ddl-rebuild-abort` | S | Do before V-1. Un-blocks a clean rebuild of the lockdown. |
| 3 | **Revoke `anon` SELECT on `profiles` + `jobs`; cut cross-user columns** (`city/major/degree_type/class_standing/grad_year/referral_code` → owner-only or opt-in). Add a service-role reduced-column route if pre-auth pages need it. | `profile-pii-cross-user`, `jobs-anon-scrapable`, `location-exposure-freetext` | M | After #1, #2. Verify with an anon-key `curl`. |
| 4 | **Block copy fix** (now) + **bidirectional block enforcement** — `NOT EXISTS(blocks)` on `messages_insert`/`messages_read`; block booking insert between blocked pairs; filter blocked conversations in the hub. | `block-not-server-enforced` | Copy S / enforcement M | Copy is a one-liner and can ship immediately; enforcement is the proper fix. |
| 5 | **Guarantee payment for completed work** — capture at mutual completion; earner-escalation/auto-advance N days after `earner_done`+slot passed (covers the never-marks-`poster_done` deadlock); hold-expiry alerting; auto-capture skips on open dispute. | `poster-ghosting-hold-expiry` | L | Highest-probability harm. Coordinate with V-4 payout delay as the dispute window. |
| 6 | **Age floor** — nullable `date_of_birth`; collect at signup + backfill at next login; enforce ≥18 at post/book/message. | `no-age-verification` | M | Action-time enforcement, not `NOT NULL`. |
| 7 | **Safety-report alerting** — insert trigger → edge function → email/push to a named on-call owner; inbox badge. | `safety-reports-no-alerting-sla` | M | Pairs with O-2/O-3 runbooks. |
| 8 | **Prohibited-use terms** in all three moderation copies + **feature-flag the assistant off** for beta. | `prohibited-activity-policy-gap`, `assistant-cost-cap-fail-open`, `assistant-prompt-injection-no-code-gate` | S | Disabling the assistant also neutralizes its cost-cap and prompt-injection findings for beta. |
| 9 | **Certificates bucket → private + signed URLs**; **`completion-photos` path guard** trigger (mirror `guard_message_image_path`). | `certificates-bucket-public-pii`, `completion-photos-writable-array-read` | S | Minutes each. |

---

## 2. Phase 2 — Config, verification & operational (evidence flips NO-GO → GO)

Runs in parallel with Phase 1. See the launch decision for the exact evidence.

| Item | Finding(s) / Purpose | Effort |
|---|---|---|
| **Live-DB introspection** (`audit.sql` / `db diff --linked`) proving policies/grants/triggers = tracked hardened set; anon denied on `profiles`/`jobs`. | `deploy-drift-rls-migration-order`, epistemic gate | S (after trap #3) |
| **Stripe webhook** live-registered, target mode, correct secret, all events (+ `charge.dispute.created` alert). | `no-chargeback-dispute-webhook`, epistemic gate | S–M |
| **Stripe live keys** in every prod env; fail-fast on `pk_test` fallback in prod. | `stripe-pk-test-fallback` | S |
| **Connect payout `delay_days ≥ 7` + manual first-payout review.** | `stolen-card-no-payout-friction` | S (dashboard) |
| **Radar rules; Connect + Identity live; backups/PITR; Auth settings** (`mailer_autoconfirm`, HIBP, OTP, redirect allowlist, admin MFA). | multiple | S |
| **Realtime authz** enabled + RLS-gated; cross-user subscription denied. | `realtime-authz-unverified` | S |
| **Money-path smoke test** (test mode) before the live flip. | `money-path-arithmetic-untested`, `db-invariants-untested` (partial) | M |
| **Anthropic key rotated;** secret scan clean. | prior-audit item | S |
| **Runbooks + owners:** money-incident (refund/reverse/pause via Stripe), safety incident-response + data-preservation, hold-expiry monitoring, gig review, Sentry monitoring wired. | `no-payout-freeze-refund-tooling`, `safety-reports-no-alerting-sla`, `no-safety-interstitial-runbook`, monitoring | M |
| **Legal:** LLC; attorney-reviewed ToS/Privacy/ICA + prohibited-use policy; insurance binding. | prior-audit blockers | External |

---

## 3. Phase 3 — Fast-follow (during beta, before scaling invites)

Not blocking a *verified*-closed beta, but close early.

| Item | Finding(s) | Effort |
|---|---|---|
| Contact-info/off-platform-solicitation detection in chat (warn + flag); consider gating free chat until poster accepts. | `grooming-funnel-instant-free-chat` | M |
| Pre-first-booking safety interstitial + in-gig "Get help"; review-retaliation shield (double-blind or safety-report suppression). | `no-safety-interstitial-runbook`, `review-retaliation-no-protection` | M |
| Lock pricing during the `pending` window (extend `has_active` or snapshot gross at book-time). | `job-price-repricing-pending-window` | S |
| `send-push`: restrict anti-spoof to active statuses; reserve `system`/`payment`/`review` types for server triggers; decide fail-open. | `send-push-notification-abuse` | S |
| Hold-release reconcile (don't wait out 7-day expiry); mirror decline ordering to cancel's. | `cancel-hold-failopen-7day`, `decline-hold-before-write` | S |
| Fix cancellation-fee copy (or implement a real transfer); pin `cancellation_fee`. | `cancellation-fee-false-money-copy` | S |
| Onboarding legal-acceptance ordering: mobile records acceptance before marking onboarded. | `onboarding-legal-acceptance-ordering` | S |
| Public-bucket MIME allowlist as a tracked migration. | `public-bucket-mime-allowlist-missing` | S |
| Tip cumulative cap + integer check + no-op-vs-success distinction. | `tip-idempotency-key-design` | S |
| Geocode per-IP rate limit. | `geocode-open-proxy` | S |
| Admin peer-check fail-closed. | `admin-peer-check-fail-open` | S |

---

## 4. Phase 4 — Before OPEN beta (post-closed-beta)

The deferred structural work, priced on the invite gate no longer being the only control.

| Item | Finding(s) | Effort |
|---|---|---|
| ID verification required to post (location-controlling party) / gate in-person flow. | `no-id-verification-post-or-book` | M |
| `charge.dispute.created` handler: record + alert + attempt transfer reversal + freeze pending review. | `no-chargeback-dispute-webhook` | M |
| Collusion/Sybil signals (shared IP/device/card fingerprint, payout-vs-card correlation); velocity caps + rolling reserve; lower single-booking cap. | `collusion-self-dealing-undetected`, `sybil-multiaccount-cheap`, `stolen-card-no-payout-friction` | L |
| Phone/OTP or device attestation at signup. | `sybil-multiaccount-cheap` | M |
| Dispute adjudication/appeal path (earner side). | (lifecycle gap) | M |
| Extract money math to `shared/finance.js` + unit tests; `supabase`-local integration harness for the guard/RPC/RLS invariants. | `money-path-arithmetic-untested`, `db-invariants-untested` | L |
| Moderation: NFKC/zero-width parity in the DB backstop; extend field coverage (requirements/slots/location/city/skills); consolidate the three copies. | `moderation-normalization-parity`, `moderation-field-coverage` | M |
| Nonce-based CSP (drop `unsafe-inline`) + a CI guard against raw-HTML sinks. | `csp-unsafe-inline` | M |
| CCPA self-serve data export; hourly-gig top-up flow; `jobs.status` guard + amendment auto-clear. | `ccpa-no-self-serve-export`, `hourly-topup-missing`, `jobs-status-unguarded`, `amendment-unscoped-core-unlock` | M |

---

## 5. Effort summary

| Phase | Rough effort | Gate |
|---|---|---|
| Phase 1 (code blockers) | ~2 focused engineer-weeks (the S/M items are fast; BL-4 is the L) | Blocks any external user |
| Phase 2 (config/verify/ops) | Days of config + runbook writing, in parallel; legal is external-dependency | Flips NO-GO → GO |
| Phase 3 (fast-follow) | ~1 week, during beta | Before scaling invites |
| Phase 4 (before OPEN) | Several weeks | Before public launch |

**Do-first triad (from the launch decision):** (1) invite gate + anon revoke (BL-1/BL-6), (2) guarantee-payment (BL-4), (3) safety loop — block that blocks + reports that page a human + LLC (BL-2/BL-3/L-1). Everything else sequences behind those.

---

## 6. What NOT to do

- **Don't `npm audit fix`** — the mobile `undici`/`@expo/*` advisories are build-time only; the suggested `next@9` downgrade is wrong.
- **Don't re-run superseded loose `supabase/*.sql` files** after the tracked migrations — several reopen hardened holes (`deploy-drift-rls-migration-order`).
- **Don't treat "screenshot of TestFlight settings" as evidence for BL-1** — the web app has open signup; only a server-side gate counts.
- **Don't delay capture past ~7 days** thinking it adds a dispute window — the authorization expires; use payout `delay_days` instead.
- **Don't flip realtime RLS or revoke anon grants without re-testing** chat and any pre-auth pages in the same change.
