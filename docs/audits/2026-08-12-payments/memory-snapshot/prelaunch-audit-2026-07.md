---
name: prelaunch-audit-2026-07
description: Pre-open-beta audit remediation state — what shipped live 2026-07-15 and the remaining launch gates
metadata: 
  node_type: memory
  type: project
  originSessionId: 1a531ed6-e2cc-4dac-809d-5af715e43214
---

Pre-open-beta senior-engineer audit completed and deployed **2026-07-15**, commit `3ef23d1` on master.

**What shipped (verified live):** 54 confirmed findings + 7 fix-induced regressions fixed across 3 Opus 4.8 passes. 12 new migrations (`supabase/migrations/20260715*`) applied to prod DB `nfioebqsgmmzhbksxozc` via `supabase db push`; 8 edge functions redeployed (earner-claim-payment, stripe-webhook, send-push, moderate-text, moderate-image, log-moderation, support-reply, support-ai-draft). Web+admin auto-deployed to Vercel. Tests 118/118.

**Critical fix:** escrow-drain via forged `bookings.starts_at` — earner could backdate a gig and self-capture the full hold. Closed by pinning `starts_at` in `guard_bookings_write` (both branches) + deriving schedule from poster-owned `job_slots` in earner-claim-payment. Adversarially re-verified closed; guard-diff audit found zero dropped pins in any rewritten guard.

**Remaining launch gates (NOT done — owner action):** (1) Stripe live-key cutover + live-mode webhook re-registration (intentionally left on test keys — see [[payments-architecture]]); (2) H6 config — safety paging / AI-moderation / notification email need live GUCs+secrets+Resend domain or they no-op; (3) purge Dallas seed data (fake verified profiles, committed shared password) before open signups; (4) legal review (draft ToS has `[DRAFT PLACEHOLDER]` arbitration clause); (5) decide ID-verification gating for post/book.

**Deferred code items (documented, not fixed):** server-side coordinate coarsening of map pins for non-parties (clients mask address text); image-moderation enforcement on direct Storage uploads; Stripe `transfer.reversed` mapping (dispute+refund events ARE handled). See [[worker-classification-and-roadmap]].
