---
name: worker-classification-and-roadmap
description: "GoHustlr worker-classification decision (1099 contractors, not employees), cash/tax strategy, and the path-to-trial roadmap"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9a2e1d9e-b5c5-4b6f-b54d-522d2ba61a0e
---

GoHustlr is a two-sided gig marketplace. **Earners are independent contractors (1099), NOT employees of GoHustlr** — same model as TaskRabbit/Uber. The platform connects posters and earners; it doesn't employ them, set hours, or control how work is done. Avoid anything implying employment (payroll, benefits, W‑2).

Taxes/money:
- Card payments run through Stripe Connect escrow → Stripe issues earners a 1099‑K past thresholds and collects W‑9 during payout onboarding. Card path is largely handled.
- **Cash payments are off‑platform/unreported** — earners self‑report. The **Tax Center** (ExpensesScreen + `expenses` table + `src/lib/expenses.js`) added 2026-06-13 lets earners log expenses + receipts and export CSV. Planned next: a cash **income** log + net-profit summary combining Stripe income + logged cash − expenses.
- TaskRabbit does not allow cash; GoHustlr currently allows it (poster picks method at verification). Open product decision: keep cash as unprotected/no‑fee convenience vs. phase out toward card-only.

"Contract from employers" ask → P2 expansion: rehire/recurring gigs + business accounts + invoicing. Not needed for first trial.

Full prioritized plan lives in `ROADMAP.md` at repo root. Customer-trial blockers (P0): legal/ToS + contractor agreement, cancellation/no-show flow, report/block + moderation, error monitoring (Sentry) + analytics, push on a real device build. See also [[payments-architecture]].

Storage caveat: all media buckets (avatars, job-photos, chat-photos, completion-photos, receipts) are public-read for now; make receipts/chat private (signed URLs) before launch.
