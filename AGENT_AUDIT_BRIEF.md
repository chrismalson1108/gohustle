# GoHustlr — Full-System Audit Brief for the Next Agent

**Hand this file to the agent as its prompt.** Everything it needs to avoid repeating a
previous agent's mistakes is here.

---

## 0. Mission

Audit and repair **the entire GoHustlr system** before an open public beta: security,
correctness, money handling, privacy, safety, **and functional/UI behaviour**. Then fix
everything you find, verify each fix, and **loop** — re-audit the patched tree — until a
full pass produces nothing new.

You are not writing a report. You are leaving the system correct. A finding you did not
fix, or fixed without verifying, is not done.

**Success is not "I found things." Success is "a fresh full audit of the current tree
finds nothing, and I proved the app still works."**

---

## 1. What this product is (why the bugs matter)

A gig marketplace where **strangers meet in person to do paid work**, with a
**minor-inclusive user base** (students). Two roles, both available to every user:

- **Poster** — lists a gig, funds an escrow hold, verifies completion, releases payment.
- **Earner** — books a slot, does the work, marks done, gets paid.

That framing decides severity. A bug that leaks a home address, lets someone be paged by
a person who blocked them, lets a worker go unpaid for real labour, or lets a minor's
date of birth be read — is severe **regardless of how clever the exploit is**. A
theoretical RLS gap on a table nobody reads is not.

**Stripe is in SANDBOX/test mode by explicit owner decision and stays that way.** Do not
propose switching to live keys. Payments are simulated; the escrow, capture, tip,
partial-refund and Connect payout code paths all still execute, so they are fully
auditable. The one *real* consequence to keep in mind: a tester who does actual work
receives simulated money — that is a disclosure concern for the owner, not a code defect.

---

## 2. System map

| Surface | Path | Notes |
|---|---|---|
| Mobile app | `src/` | React Native, Expo SDK 54. 95 files. |
| Web app | `web/` | Next.js **16** — read `web/AGENTS.md` first, it is **not** the Next.js you know (`middleware` is now `proxy`). Bundled docs in `web/node_modules/next/dist/docs/`. |
| Admin console | `admin/` | Next.js. Holds `SUPABASE_SERVICE_ROLE_KEY` — **bypasses all RLS**. Highest-value target in the system. |
| Edge functions | `supabase/functions/*/index.ts` | 28 Deno functions: Stripe, moderation, push, assistant, support, deletion, student verification. |
| Database | `supabase/schema.sql`, `supabase/migration_*.sql`, `supabase/migrations/*.sql` | ~95 tracked migrations. |
| Shared | `shared/` | Cross-client logic. Three consumers must agree. |
| Tests | `__tests__/` | 187 Jest tests, pure logic only. |

Project ref `nfioebqsgmmzhbksxozc`. The Supabase CLI is installed and linked.

---

## 3. NON-NEGOTIABLE METHOD RULES

These are not style preferences. Each one corresponds to a real mistake that was caught
only because it was checked.

### 3.1 The database is cumulative — the last definition wins

Effective DB state = `schema.sql`, then `supabase/migration_*.sql` (hand-applied), then
`supabase/migrations/*.sql` **in timestamp order**. A later migration silently redefines
earlier policies, triggers, functions, grants and constraints.

**Before reporting ANY database finding, grep the whole `supabase/` tree for every later
redefinition and confirm the weakness survives in the final state.** Reporting a hole
that a later migration already closed is the single most common failure mode here.

### 3.2 Never rewrite a DB function from memory — generate it and diff it

When you modify an existing function, **extract the authoritative version programmatically
and apply a targeted replacement**, then diff the two bodies and confirm only your
intended lines changed. Three real near-misses in the last audit, all caught by this:

- A rewritten moderation trigger **silently dropped the `service_role` bypass** — would
  have subjected every admin-console and edge-function write to the content filter.
- A rewritten dashboard function **invented metric names that don't exist**
  (`users_7d` instead of `signups_today`/`signups_7d`/`signups_30d`/`suspended_users`) —
  would have broken the admin dashboard.
- A hand-copied 56-term blocklist would have drifted from its two siblings.

```python
# The pattern that works:
src = open('supabase/migrations/<authoritative>.sql').read()
i = src.index('create or replace function public.<name>')
fn = src[i:src.index('$$;', i) + 3]
assert OLD_LINE in fn            # fail loudly if the source moved
fn = fn.replace(OLD_LINE, NEW_LINE, 1)
# then diff fn against the original and eyeball every changed line
```

### 3.3 Verify findings adversarially before acting on them

A previous 400-agent audit reported 123 findings: **65 were refuted**. Critics reported
19: **15 refuted**. Assume most of what you find is wrong until you have re-read the
current code yourself.

For each candidate finding, check three lenses:
1. **Does the code actually say this?** Open the file now. Early return? Existing guard?
2. **Is it already mitigated?** Later migration, DB constraint, guard trigger, edge check.
3. **Is it reachable and consequential?** Walk it as an attacker with only their own JWT
   and `curl`. Does every step work? Does the impact matter for this product?

### 3.4 A recommended fix can be worse than the bug

The previous audit's top recommendation for a data-loss bug was
`grant select (date_of_birth) on profiles to authenticated`. That would have exposed
**every user's date of birth to every signed-in user** — because `profiles_select_all` is
`USING(true)` and **column grants are table-wide, not row-scoped**. Trading a data-loss
bug for a PII leak on a platform with minors.

**Always ask: what does this fix expose, and to whom?**

### 3.5 Traps specific to this stack

- **`revoke ... from public` does NOT remove `anon`'s grant.** Supabase ships
  `ALTER DEFAULT PRIVILEGES` granting EXECUTE to `anon` directly. You must
  `revoke ... from anon` explicitly. Two functions were anon-callable because of this.
- **Trigger firing order is alphabetical by name.** `trg_guard_booking_photo_paths` runs
  *before* `trg_guard_bookings_write` (`_` sorts before `s`), so it saw a forgeable
  `earner_id`. If your guard depends on another guard having run, check the names.
- **On UPDATE, resolve identity from `OLD`, never `NEW`.** `NEW` is client-supplied.
- **Public storage buckets bypass RLS** on `/object/public/...`, but `/object/list/...`
  does evaluate it. One `SELECT` policy governs both download and enumeration.
- **RLS policy expressions run as the querying role** — an inline subquery touching a
  column that role lacks can fail. Use a `SECURITY DEFINER` helper in the non-exposed
  `private` schema (see `private.is_blocked_pair`, `private.is_suspended`).
- **Don't interpolate user input into PostgREST `.or()` filters.** Validate UUIDs first —
  filter syntax is comma/paren delimited and can be broken out of.
- **`supabase/functions` use the service role and bypass column grants.** Selecting a
  private column there is legitimate; doing it from a user-scoped client is not.

---

## 4. Already fixed — do NOT re-report

34 issues were fixed, applied to production, and pushed. Re-reporting them is noise.
Read `git log 6762fba..HEAD` for the full set with reasoning. Summary:

**Storage/PII** — anonymous enumeration of `avatars`/`job-photos`/`certificates` closed;
`certificates` added to every purge path and to image moderation; anon SELECT revoked on
14 owner-scoped tables; anon EXECUTE revoked on all `SECURITY DEFINER` functions;
`mask_location` no longer fails open on labels containing "remote"; stale exact addresses
cleared; GDPR export no longer discloses reporter/blocker identities.

**Money** — `delete-account` refuses while escrow is unsettled or a report is open;
`job_slots` with a live booking can't be deleted and `starts_at` can't be moved;
`disputes_insert_party` dropped (server-authored only); `earner-claim-payment` gained a
second anchor for gigs 4–6 days out; `stripe-webhook` needs a status precondition and no
longer demotes when `earner_done`; GMV uses captured, not authorized; Tax Center and
money-goal are year-scoped and fee-net.

**Safety/moderation** — `send-push` enforces blocks bidirectionally and uses server-defined
text for not-yet-accepted bookings; `profiles.name`/`username`/`bookings.slot_label` under
the content backstop; plural forms no longer bypass the blocklist; moderation fails
**closed** on its own 429; `reports` rate-limited (excluding `source='auto'`); suspension
cascades; `school` pinned and always derived from the verified domain.

**Correctness** — Settings profile-wipe (both clients); web gig-edit reconciles slots;
web Book CTA disabled when no slot is available; web clears cache on session death; web
verify fails safe; `bumped_at` clamped to `now()`; amendment unlock is per-booking;
`notify_saved_searches` can no longer abort another user's job insert.

**Ops** — `client_errors` sink + `log-client-error` function + admin `/errors` page;
escrow-hold expiry now alerts instead of failing silently; per-IP throttle on
`/api/geocode`.

---

## 5. Known-open — deliberate, not defects

Do not re-report these. **Do** report anything that makes them worse or that they enable.

1. **Gigs scheduled 7+ days after acceptance have no self-service payout path** if the
   poster ghosts. Stripe auto-cancels the uncaptured authorization ~7 days after it is
   *placed* (at accept time), so the hold dies before the work is due. Needs
   re-authorization architecture. It now alerts the admin instead of failing silently.
2. **Stripe is in sandbox.** See §1.
3. **PITR is off** (24h worst-case data loss) and **Storage has no backups** — a DB
   restore does not bring back avatars or completion photos. Owner decisions.
4. **Disputes have no adjudication path** — terminal audit rows (`KNOWN_RISKS.md` §5.2).

`KNOWN_RISKS.md` is the register of previously accepted risks. Read it before filing
anything — but note it is **not** exhaustive: the storage enumeration hole was absent from
it and had survived 14 review rounds.

---

## 6. Audit dimensions

Cover all of these. **§6.9 is where the previous audit was weakest — prioritise it.**

**6.1 Database/RLS** — every table, every verb; UPDATE policies with `USING` but weak/missing
`WITH CHECK`; INSERT policies not pinning the owner; `USING(true)`; grants broader than
intended; column-level grants; `SECURITY DEFINER` bodies, `search_path`, and EXECUTE grants;
guard triggers and which columns/transitions they miss; storage bucket policies and path
guards.

**6.2 Edge functions** — JWT verification; resource-ownership checks (IDOR); CORS; rate
limits; input validation; error leakage; and for Stripe: amounts recomputed server-side,
idempotency, partial-capture math, fee correctness, funds reaching the right account.

**6.3 Money** — integer cents vs float; rounding that creates or loses cents; double
capture/tip; earnings drift; negative/zero/overflow amounts; anything displayed to a user
as money that could be wrong.

**6.4 Booking lifecycle** — enumerate every transition the DB actually permits and find the
impossible ones. Races: double-booking a slot, double-submit of accept/verify/capture,
concurrent profile writes, realtime vs optimistic state.

**6.5 Privacy/PII** — exact address, DOB, email, phone, coordinates, Stripe IDs; who can read
what through profiles, jobs, reviews, messages, push payloads, the notifications inbox,
search, the assistant, and the admin export. Account deletion completeness across tables
**and** every storage bucket.

**6.6 Safety/abuse** — age floor on every write path; block enforcement everywhere (messages,
bookings, push, search, profiles, support); suspension actually locking someone out;
report/moderation flooding; fee evasion and off-platform contact exchange; free work;
payment without work; review manipulation; colluding accounts.

**6.7 Moderation** — every user-generated text field covered by the server backstop (find one
that isn't); evasion (unicode, homoglyphs, zero-width, leetspeak, spacing, inflection);
client/server parity; images moderated *before* others see them; failure modes fail-open vs
fail-closed and whether a user can *induce* the failure.

**6.8 Admin console** — every page **and every server action** gated server-side.
**Next.js server actions are callable POST endpoints; a layout guard does not protect
them.** MFA actually enforced. Service client unreachable from the browser bundle. Every
privileged action audited, unforgeable. Stored XSS from user content rendered in an admin's
browser — that browser holds the service-role key.

**6.9 FUNCTIONALITY AND UI — RUN THE APPS. THIS IS THE PRIORITY GAP.**

The previous audit was almost entirely static analysis. It never launched the app, never
clicked a button, never saw a screen render. **You must actually drive all three surfaces.**

- **Mobile**: use the iOS Simulator tooling. Attach the live panel *first*, then build and
  launch. Drive real flows and screenshot to prove them.
- **Web**: start the dev server via the preview tooling (never a raw shell), then use the
  browser tools — `read_page` for structure/text, console and network reads for errors,
  clicks and form input for interactions, `resize_window` for responsive and dark mode.
- **Admin**: build and run it; it needs an admin login + MFA, so coordinate with the owner
  if you cannot authenticate.

Flows that must be walked end to end, on **both** mobile and web, comparing them:

1. Sign up → onboarding (DOB, role, location, skills) → consent gate
2. Sign in, sign out, password reset, session expiry
3. **Browse loads and shows gigs** — highest risk: `jobs_select_all` was rewritten and has
   never been observed under an authenticated session. If Browse is empty, that is a
   production outage, not a finding.
4. **Settings loads populated, and Save does not blank the profile** — this exact bug
   shipped and destroyed profiles.
5. Post a gig (with and without times; photos; custom category)
6. Open a gig → pick a slot → counter-offer → book
7. Accept → escrow hold → mark done (both sides) → verify + rate → tip
8. Chat: send text and an image; verify blocked content is rejected
9. Report, block — and confirm the blocked user genuinely cannot reach you
10. Tax Center: add expense/income, check year figures, export CSV
11. Availability, favourites, saved gigs, referrals, certifications, trophy case, insights
12. Account deletion (expect refusal while escrow is unsettled or a report is open)

For every screen also check: empty states, loading states, error states, long text
overflow, missing images, offline/slow network, and that no screen crashes on
null/deleted/soft-deleted related rows.

**Anything visibly wrong is a finding**: broken layout, unreadable contrast, a button that
does nothing, a spinner that never resolves, a toast that lies about success, a screen that
shows another user's data, wrong money, wrong dates.

**6.10 Cross-layer chains** — the class single-layer auditing structurally cannot find, and
where the one CRITICAL of the last round came from. Which edge functions read a DB value a
*user* can write and then act on it (confused deputy)? What does a second colluding account
unlock? What does the public web bundle reveal that can then be hit directly with `curl`?
Can a user attack an admin? Can the assistant be induced to act for another user? Can a
crafted realtime row corrupt another user's state?

**6.11 Ops** — is there any path by which the team learns about a crash, a failed capture, or
a wedged booking without a user reporting it? Can support actually resolve a stuck booking,
a disputed payment, a safety report? What happens when Stripe/Resend/Expo/Anthropic is down
— fail open or closed, sane error or wedged screen? Unbounded cost paths? Rollback?

**6.12 Tests** — which highest-risk behaviours have **no** test? Are any tests vacuous (assert
a mock, assert a constant, or test a copy of the logic rather than the shipped module)?

---

## 7. Verification — prove it, don't assert it

### Static (fast, run constantly)
```bash
npm test                                   # 187 tests
(cd web && npx tsc --noEmit)               # must exit 0
(cd admin && npx tsc --noEmit)             # must exit 0
(cd web && npm run build)                  # typecheck != build; build catches more
(cd admin && npm run build)
npx expo export --platform ios --output-dir /tmp/x   # mobile actually bundles
```

### Live production probes (safe, read-only, no data created)
The public anon key is in `src/lib/supabase.js` — it is already public in the app bundle.
Use it to prove things empirically rather than reasoning about SQL:

```js
const B='https://nfioebqsgmmzhbksxozc.supabase.co';
const A='<publishable key from src/lib/supabase.js>';
const H={apikey:A,Authorization:`Bearer ${A}`,'Content-Type':'application/json'};

// tables anon must NOT read  -> expect 401/42501
await fetch(`${B}/rest/v1/profiles?select=*&limit=1`,{headers:H});
// legal_documents MUST stay 200 (public by design) — catches over-revocation
await fetch(`${B}/rest/v1/legal_documents?select=slug&limit=1`,{headers:H});
// storage enumeration -> expect []
await fetch(`${B}/storage/v1/object/list/avatars`,{method:'POST',headers:H,
  body:JSON.stringify({prefix:'',limit:100})});
// public rendering MUST still work -> expect 200 image/jpeg
await fetch(`${B}/storage/v1/object/public/avatars/<uid>/<file>.jpg`);
// every edge function unauthenticated -> expect 401/403
await fetch(`${B}/functions/v1/<fn>`,{method:'POST',headers:{apikey:A},body:'{}'});
// definer RPCs -> expect 401
await fetch(`${B}/rest/v1/rpc/profile_availability`,{method:'POST',headers:H,
  body:JSON.stringify({uid:'00000000-0000-0000-0000-000000000000'})});
```

**Every security fix needs a positive control too.** Proving the hole is closed is half the
job; proving you did not break the legitimate path is the other half. Closing storage
enumeration while breaking avatar rendering would be a worse outcome than the bug.

### Do not create test data in production
Exercising authenticated flows means real users and bookings in the live DB. **Do that in
the simulator/dev app against the real backend only with the owner's agreement**, and say
plainly which guards you could not exercise. Being explicit about "this rests on code
review, not live proof" is worth more than a false claim of coverage.

---

## 8. The fix loop — repeat until a full pass is clean

```
1. AUDIT      cover §6. For every candidate, apply the three lenses (§3.3).
2. VERIFY     re-read the current code yourself. Refute aggressively.
3. FIX        smallest change that closes it. For DB functions use §3.2.
              Ask what the fix EXPOSES (§3.4).
4. PROVE      re-run the exact repro -> now blocked.
              Run the positive control -> legitimate path still works.
              Static suite green. Rebuild/redeploy. Re-drive the affected UI flow.
5. REGRESS    add a test. Prefer a STRUCTURAL INVARIANT over a point fix, and
              PROVE the test fails without the fix by reintroducing the bug.
6. COMMIT     one logical fix per commit. Body: what was wrong, the concrete
              exploit, why this fix and not the obvious one, what you verified.
7. LOOP       go to 1 over the PATCHED tree. Stop only when a full pass finds
              nothing new AND every flow in §6.9 passes.
```

**Structural invariants earn their keep.** Two written in the last round each caught a bug
the author had missed within seconds:
- `__tests__/storagePolicies.test.js` replays every migration and asserts no surviving
  `SELECT` policy on `storage.objects` is bucket-wide → caught a **third** exposed bucket.
- `__tests__/profileColumnGrants.test.js` replays every `grant select (...) on profiles`
  and asserts no client selects an ungranted column → catches the entire data-loss class.

Write more of these. A test that only pins today's bug is worth far less.

**Expect to find bugs in your own fixes.** Two of the four findings in the final critic
pass were defects in fixes made earlier in that same audit. Budget a dedicated pass that
audits *your own* changes with the same hostility.

---

## 9. Deploying — where things actually go live

| Change | How it ships | Trap |
|---|---|---|
| `supabase/migrations/*.sql` | `supabase db push --linked --yes` | Dry-run first: `--dry-run`. Check `supabase migration list --linked` for drift. |
| `supabase/functions/*` | `supabase functions deploy <name> --project-ref nfioebqsgmmzhbksxozc` | **Code changes do nothing until deployed.** New functions inherit `verify_jwt = true` unless listed in `supabase/config.toml`. |
| `web/` | Deploys from the repo | Verify a change is actually live before assuming. |
| `admin/` | **MANUAL: `cd admin && npx vercel --prod`** | **It does not auto-deploy.** It was found **12 days stale**, with a CRITICAL money fix sitting undeployed. Always check `npx vercel ls`. |
| `src/` (mobile) | EAS build → TestFlight | Client-side fixes reach nobody until a new binary ships. |

**Release mechanics:** `eas.json` sets `appVersionSource: "local"` with
`production.autoIncrement: true` — **EAS bumps `buildNumber`/`versionCode` itself at build
time**. Set `version` in `app.json` by hand; leave the build numbers alone and commit what
EAS produces. Currently **1.3.1**.

Work on a branch (`security/audit-<date>`), merge to `master` with `--no-ff`, push both.
Never commit secrets; `.env*` is gitignored and must stay that way.

---

## 10. Definition of done

- [ ] Every confirmed finding fixed, each with a proven repro-then-blocked, and a positive
      control proving the legitimate path still works
- [ ] A full re-audit of the patched tree finds nothing new
- [ ] A dedicated hostile pass over **your own** changes finds nothing
- [ ] Every flow in §6.9 walked on mobile **and** web, with screenshots
- [ ] `npm test` green; web + admin typecheck **and build**; mobile bundles
- [ ] Live probes pass, including the positive controls
- [ ] Migrations applied with no drift; changed edge functions deployed; **admin deployed**
- [ ] Committed and pushed, one logical fix per commit
- [ ] A final report that separates: **fixed and verified** / **fixed but not
      end-to-end verified** / **known-open with reasoning** / **needs an owner decision**

**Report honestly.** If something is unverified, say so and say why. "This rests on code
review because exercising it needs production data" is a professional answer. Claiming
coverage you do not have is not — and on this product the cost of a missed bug is someone
not being paid for real work, or a stranger reaching a person who blocked them.
