# Why nine audits kept missing things

Written 2026-07-30, after the tenth. This is the answer to "how can we keep doing these
audits and there's things we missed?" — grounded in what the repo actually shows, not in
reassurance.

## The measurements

Fourteen audit/hardening branches exist. Eight rounds ran between 2026-07-22 and
2026-07-26 alone. Here is the number that explains the pattern:

| After round | Test files |
|---|---|
| 2026-07-22 | 19 |
| 2026-07-25 | 20 |
| 2026-07-26 | 21 |
| 2026-07-26-r4 | 21 |
| 2026-07-26-r8 | 21 |
| **2026-07-30 (this round)** | **29** |

**Eight rounds of auditing added two test files.** Fixes accumulated; *coverage* did not.

Second number: of 72 findings raised this round by 15 specialist agents, **32% were
refuted** by a second reader. A third of what a careful auditor produces is wrong.

## Why it happens

**1. An audit samples. It does not cover.** Each round is a fresh search over the same
space, and what it can reach is set by the *instrument*, not the effort. Nine rounds
read the code. Running the same instrument again draws another sample from the same
distribution — it does not reach what that instrument cannot see. Adding agents buys
more samples, not more coverage. That is why round nine still found things: it was never
converging.

**2. The highest-value bugs this round were invisible to code reading.** Not hard to
see — *invisible*, because every individual file was correct:

- The money goal read `$45` on web and `$41` in the app. Both files were internally
  consistent. The defect existed only in the *disagreement*.
- Tax Center showed a lifetime total as one year's income — `stripeIncome: earningsTotal`
  reads perfectly fine on its own line.
- There was no way to sign out of the web app. Nothing to read; the code was *absent*,
  and a comment said it lived somewhere it didn't.
- A `$100/hr` gig displayed as `$100`.

You cannot find these by reading harder. You find them by running both clients side by
side on one account and noticing two numbers that should match and don't.

**3. Nothing ratcheted.** Because rounds left behind fixes but not invariants, round N+1
started from the same floor as round N — same instrument, same space, no memory. Nine
rounds of un-compounded effort look identical to one round repeated nine times.

**4. The register was read as a map of what exists.** `KNOWN_RISKS.md` is a list of what
has been *found*. Its silence is not evidence of absence — it said so, and was still
treated that way. The storage-enumeration hole survived 14 review rounds while absent
from it.

## What actually changes the outcome

**Change the instrument every round.** The ones that paid this time, in order of yield:

1. **Run both clients side by side on one account.** Nearly every money defect this round
   was a disagreement between two surfaces, not a bug in either.
2. **Replay the migrations and assert on the final state.** The DB is cumulative; reading
   any single migration tells you almost nothing about what is live.
3. **Probe production read-only.** 84 assertions against the live API took minutes and
   proved things no amount of reading could — including that there is no migration drift.
4. **Drive the UI.** Overflow, dead buttons, wrong money, missing controls. All of it
   free, none of it reachable by static review.

**Make every finding leave an invariant behind.** This is the part that makes rounds
compound. Five of this round's tests are structural rather than point fixes:

- `moderationCoverage` — replays every migration, resolves the FINAL guard body, asserts
  the whole expected column set per table. It caught `profiles.skills` immediately after
  catching `jobs.location`, and pins the `service_role` bypass a previous rewrite dropped.
- `bookingInsertPins` — asserts the whole server-owned column set on INSERT, so the next
  column pinned on UPDATE but not INSERT fails there.
- `cancelPaymentContract` — pins the edge function against the admin cascade, making
  `deleteUser.ts`'s "Mirrors the edge function" comment true rather than aspirational.
- `adminLinks` — every admin URL in every edge function must resolve to a real route.
- `storagePolicies` / `profileColumnGrants` (earlier rounds) — the two that already
  worked, and the template for the rest.

The test is not "does this bug exist." It is "**can this CLASS exist**." A test that pins
today's bug is worth almost nothing; a test that replays the migrations and asserts the
shape is worth a whole round.

**Expect to break things while fixing them.** Of this round's fixes, one introduced a
truncation defect (caught by re-driving the app), one rendered `$-12.50` (caught by its
own test), and one relied on `AND` short-circuiting in plpgsql in a way PostgreSQL does
not guarantee — which would have broken gig posting outright, and was caught only by
re-reading my own migration. Budget a hostile pass over your own diff. It is not optional.

**Trust two readers, not one.** At a 32% refute rate, acting on a single finding wastes a
third of the effort — and, worse, the one CRITICAL this round was refuted *by me* and
upheld by both independent refuters. I checked what the code said instead of walking the
sequence. Adversarial verification is not ceremony.

## The honest limit

None of this makes an audit exhaustive. Nothing does. What it changes is the *floor*:
every class converted into a replaying invariant is a class that cannot come back, so
round eleven starts above round ten instead of beside it. The goal is not "find
everything." It is "**never find the same kind of thing twice**."

Judged that way, the previous nine rounds mostly failed — not through lack of rigour, but
because they were measured by findings closed rather than by classes retired.
