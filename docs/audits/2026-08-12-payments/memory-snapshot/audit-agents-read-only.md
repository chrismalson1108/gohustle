---
name: audit-agents-read-only
description: Adversarial audit subagents must run READ-ONLY against production; round-1 writes caused real cleanup twice
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 21988eb9-afe9-4353-94d6-d78a7aa1b9f2
  modified: 2026-08-12T05:17:29.061Z
---

Adversarial audit subagents pointed at the GoHustlr production database must be
constrained to **read-only**: no writes, no impersonation/forged JWT claims, no calling
live side-effectful functions (SOS, payments), no individual PII.

Round 1 (2026-08-11) ran without that constraint and caused two real problems that had
to be found and undone by hand:

1. It disabled `ctl_admin_login_bruteforce` via the console (`admin_audit_log` id 145,
   02:26). It stayed off for hours. Nothing noticed, because a disabled control reports
   neither errors nor staleness — every sweep truthfully said "0 errored, 0 stale" while
   that area went unwatched. Fixed by `ctl_control_disabled` (20260806280000).
2. It ran DELETE/TRUNCATE probes against `admin_audit_log`, inserted a `trust` admin
   role, forged claims impersonating real users, and invoked the live emergency function.
   No damage persisted (pg_net enqueues transactionally, so IDs 13–102 never dispatched),
   but confirming that took a full verification pass.

**Why:** an adversarial agent's job is to try things that break systems. Against
production, "it worked" and "it broke something" are the same outcome. The classifier
blocking two of those simulations was correct behaviour, not an obstacle to route around.

**How to apply:** state READ-ONLY explicitly in the audit prompt. Anything that must
mutate belongs on a branch database, not this one. When an audit round finishes, diff
security-relevant state (enabled controls, admin roles, RLS policies) against what it was
before — the damage is not always where the agent said it looked.

Related: [[prelaunch-audit-2026-07]], [[ship-when-green]]
