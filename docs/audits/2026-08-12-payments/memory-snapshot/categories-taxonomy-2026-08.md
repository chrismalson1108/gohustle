---
name: categories-taxonomy-2026-08
description: "Dynamic category taxonomy — product decisions Chris made; migration LIVE and app builds shipped to TestFlight (v1.4.2 b25/b26)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 53cd8de7-e0b8-4edb-9b9f-d783eb47160b
  modified: 2026-08-06T19:31:17.403Z
---

On 2026-08-05 the seven hardcoded college-flavoured job categories were replaced with
a DB-backed taxonomy shared by job categories, profile skills and job tags. The
architecture is documented in CLAUDE.md ("Categories & skills") — this note records
the decisions and state that the code does not show.

**Chris's product decisions** (asked and answered before implementation):
1. **User-created categories go live immediately**, marked `community`, with the admin
   console curating afterwards (promote / rename / merge). He explicitly chose this
   over "private until an admin promotes it" and over a catalog-only, no-create model.
2. **Profile skills were unified onto the same taxonomy** rather than kept separate —
   this deleted a 20-item `SKILL_OPTIONS` list that had been duplicated in four files.
3. **Six pre-existing bugs found in the surrounding category code were fixed in the
   same change**, at his direction, rather than deferred.

**DEPLOYED to production 2026-08-05** via `supabase db push --linked` (migration
`20260805000000_dynamic_categories.sql`). Verified live: 199 canonical + 63 merged +
9 reserved rows, 19 groups, all 16 existing gigs backfilled with a `category_slug`
(zero missing), and the SQL `category_slug()` proven byte-identical to the JS
`categorySlug()` on every edge case including NFKD accent folding. The normalize
trigger was tested end-to-end inside a DO block that always raises, so the insert and
all AFTER-trigger effects rolled back atomically — nothing was written.

**Verified on the iOS simulator 2026-08-05** (Chris signed in; I cannot type passwords).
Driving the real app found three bugs that 400+ unit tests and clean typechecks all
missed — dead browse chips derived from the raw job list, aliases being resolvable but
not searchable ("lawncare" dead-ended the picker), and recents being empty for every
existing user. All fixed and pushed. Lesson worth keeping: for this codebase the
simulator pass is not ceremony, it is where the real bugs surfaced.

**SHIPPED to TestFlight** as v1.4.2 build 25, then build 26 (2026-08-06) carrying the
category-sheet keyboard fix. The DB half is backwards-compatible either way, since
`jobs.category` still holds the display label. Deploy order still matters for any FUTURE
build: push the migration before shipping app builds, because new builds select
`jobs.category_slug` and PostgREST fails the whole jobs query if the column is absent.

**guard_profiles_write ends with `return old;`** — any server-side UPDATE to profiles
run without an auth.uid() (a migration, psql) is SILENTLY DISCARDED. Use the sanctioned
escape hatch: `set_config('app.recompute','on',true)` inside a DO block. A bare
`SET LOCAL` warns and does nothing when the CLI has no transaction open.

**Four community categories already existed in production** from the old "Other" box —
Golf, Fishing, Love, Nails. They were invisible in browse before (findable only under
"All"). Note `Nails` (community) vs the seeded `Nail Tech` — a natural first exercise
of the admin console's merge tool.

**No Docker or local Postgres on this machine**, so SQL cannot be executed locally;
use the Management API query endpoint for verification (the CLI's personal access
token is in the macOS keychain under service name `Supabase CLI`). `supabase db dump`
and `db diff` both require Docker and will fail.

**Environment gotcha worth remembering:** both `node_modules/caniuse-lite` (root) and
the whole `web/node_modules/@next` scope were missing, which silently broke the ENTIRE
jest suite and the web build respectively. If tests or builds fail in a way that looks
unrelated to the code, check for a pruned `node_modules` before debugging the change.

Related: [[design-direction-2026-07]], [[web-design-system]], [[prelaunch-audit-2026-07]].
