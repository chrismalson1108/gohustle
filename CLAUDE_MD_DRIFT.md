# CLAUDE.md drift — measured 2026-08-13

⚠️ **AT LEAST ONE FINDING IN THIS FILE IS WRONG.** The claim that
`__tests__/adminSurface.test.js` does not enforce the control-registration guarantee was
asserted by TWO independent agents and is FALSE — verified 2026-08-13 by injecting an
unregistered `ctl_*` function and an unlinked console page, both of which the test caught
and named. Treat every entry below as a lead to verify, not a fact. Two agents agreeing is
not evidence.


Seven code surfaces diffed against what CLAUDE.md claims, by seven independent agents.
**79 things exist that the doc never mentions; 33 things the doc asserts are wrong.**

This file exists because the findings would otherwise have lived only in a session
transcript — the exact failure CLAUDE.md's own 'Unfinished work' section warns about.
Every surface below was judged mechanically enumerable, so this list is the
specification for `__tests__/claudeMdInventory.test.js`, not a one-off cleanup.

⚠️ The **wrong claims** matter more than the omissions. An omission makes a session
search; a wrong claim makes it confident.

## mobile screens — /Users/chrismalson/Documents/gohustle/src/screens/ vs CLAUDE.md "Key Screens" table + Navigation tree

*Mechanically enumerable: True*

### CLAUDE.md says this, and it is wrong

- **[low]** Key Screens table, PaymentsScreen row: 'Registered in Earn/Gigs/Profile stacks.'
  - Reality: Registration is accurate (App.js:120, 133, 171) but the GigsStack registration has no entry point — the only navigate('Payments') calls are EarnScreen.js:709, PayoutSetupScreen.js:221 and SettingsScreen.js:107, none of which sit in GigsStack. A poster cannot reach Transactions from the Hire tab. The phrasing reads as availability and would let someone 'wire up' a link they think already exists, or assume the poster-side ledger is already discoverable.
- **[low]** Key Screens table, ManageBookingsScreen row: 'Registered in ProfileStack but unreachable — nothing navigates to it.'
  - Reality: VERIFIED CORRECT, no action needed. `grep -rn "navigate('ManageBookings'" src/ App.js` → 0 hits; the only references are the App.js:29 import and App.js:163 registration. Recorded so a future audit does not re-flag it, and so the mechanical test below is written to exempt it rather than 'fix' it.
- **[medium]** Key Screens table, ProfileScreen row: 'Stats, badges, reviews received, "Manage my gigs" (→ Gigs tab), Payments, Tax Center, Saved gigs/people, identity + student verification, Settings link.'
  - Reality: The Saved rows were REMOVED from ProfileScreen and now live only in Settings. `grep -n "SavedGigs\|Favorites" src/screens/ProfileScreen.js` → 0 hits; the only navigations are SettingsScreen.js:134 (`go('SavedGigs')`) and :136 (`go('Favorites')`). ProfileScreen.js:413-419 carries the explicit comment 'ALERTS STAYS, SAVED MOVED TO SETTINGS … Both already existed there, so this removes a duplicate rather than a destination.' Separately, the row's 'Payments' is also imprecise: ProfileScreen.js:403 navigates to `PayoutSetup`, not to the `Payments` (Transactions) route — ProfileScreen has no navigate('Payments') at all. A session told to touch 'the Saved rows on ProfileScreen' edits the wrong file and re-introduces the duplicate the comment says was deliberately deleted.
- **[medium]** Navigation fence names the five stack roots as HomeScreen / EarnScreen / GigsScreen / MessagesScreen / ProfileScreen (e.g. 'HomeStack: HomeScreen → JobDetail → …').
  - Reality: No such routes exist. App.js registers HomeMain (106), EarnMain (119), GigsMain (132), MessagesMain (147), ProfileMain (162). The doc is naming components where every other entry in the same fence names routes, and CLAUDE.md itself insists route names are 'a wire protocol'. navigate('HomeScreen') or { screen: 'ProfileScreen' } silently fails.

### Exists, undocumented

- **[high]** `PayoutSetupScreen` — /Users/chrismalson/Documents/gohustle/src/screens/PayoutSetupScreen.js
  - 24KB money hub — Stripe Connect bank onboarding for earners AND card-on-file for posters (its own header comment: 'Unified GoHustlr Payments hub … Get paid for work → connect / manage a bank … Pay for gigs → add / change / remove a card'). It has NO row in the Key Screens table. CLAUDE.md mentions the string 'PayoutSetup' only twice in passing (SecurityScreen row: 'Prompted from PayoutSetup once a bank is connected'; the step-up section: 'starting Connect onboarding requires aal2') without ever saying what the screen is. It is the entry point from ProfileScreen.js:306 and :403, GigsScreen.js:352 and EarnScreen.js:729. A session told to change how users connect a bank has no pointer to this file, and CLAUDE.md's own rule is that money features carry extra obligations — the screen carrying them is the one screen not documented.
- **[high]** `NotificationsScreen and NotificationSettingsScreen (two screens, cross-wired titles)` — /Users/chrismalson/Documents/gohustle/src/screens/NotificationsScreen.js and /Users/chrismalson/Documents/gohustle/src/screens/NotificationSettingsScreen.js
  - Neither is in the Key Screens table, and the route names are inverted relative to their titles: App.js:168 registers route `Notifications` with title 'Alerts' (it is the alerts INBOX — listNotifications/markRead/archive, inbox+archived tabs), and App.js:169 registers route `NotificationSettings` with title 'Notifications' (it is the per-category push/email PREFERENCE switches). A session asked to 'add a notification setting' and navigating by the doc's nav-tree entry `Notifications` lands in the inbox and edits the wrong screen. ProfileScreen surfaces both (line 427 → Notifications/'Alerts', line 519 → NotificationSettings/'Notification settings'), so the mistake is easy to make and not obviously wrong on open.
- **[low]** `MessagesScreen, ChatScreen, ConsentScreen` — /Users/chrismalson/Documents/gohustle/src/screens/{MessagesScreen,ChatScreen,ConsentScreen}.js
  - Absent from the Key Screens table, but each is described in prose elsewhere (the 'Messages hub' paragraph covers MessagesScreen and ChatScreen; App Flow step 4 and the Legal docs section cover ConsentScreen), so a session will find them. Listed only so the table's omissions are complete — the fix is a table row, not new documentation.
- **[medium]** `HomeMain / EarnMain / GigsMain / MessagesMain / ProfileMain (the five stack ROOT route names)` — /Users/chrismalson/Documents/gohustle/App.js:106,119,132,147,162
  - CLAUDE.md's Navigation fence writes the roots as 'HomeScreen', 'EarnScreen', 'GigsScreen', 'MessagesScreen', 'ProfileScreen' — those are the COMPONENT names; the actual route names are HomeMain/EarnMain/GigsMain/MessagesMain/ProfileMain and appear nowhere in the doc. These are load-bearing exactly the way the doc says tab route names are: src/components/FloatingTabBar.js:12 keys tab-bar behaviour off `HUB_ROUTES = new Set(['HomeMain','EarnMain','GigsMain','MessagesMain','ProfileMain'])`, PostJobScreen.js:249 does navigate('GigsMain'), PayoutSetupScreen.js:401 does navigate('ProfileMain'). A session writing navigate('ProfileTab', { screen: 'ProfileScreen' }) — copying the doc's own documented cross-tab pattern (GigsScreen.js:352) — silently no-ops.
- **[medium]** `MarketInsightsScreen` — /Users/chrismalson/Documents/gohustle/src/screens/MarketInsightsScreen.js
  - Appears in the nav fence as a bare route name only; the Key Screens table has no row and nothing describes it. Its header comment: 'the Pro area heat-map. Calls the read-only `area_market_stats` aggregate RPC; on error/empty it falls back to computeAreaInsights() over the already-loaded public jobs feed'. So it has a server-side RPC dependency and a degraded client fallback that a new session would not know exists — reached from HomeScreen.js:292.
- **[medium]** `AvailabilityScreen` — /Users/chrismalson/Documents/gohustle/src/screens/AvailabilityScreen.js
  - Route name only in the nav fence, no table row, no description. It is the work-status / hours / class-schedule editor (ProfileScreen.js:525 'Availability & schedule — Set your work status, hours & classes'; SettingsScreen.js:91). It already has its own guard, __tests__/availability.test.js, so the logic is considered worth protecting while the screen itself is undocumented.
- **[medium]** `TrophyCaseScreen, ReviewsScreen, SavedGigsScreen, FavoritesScreen` — /Users/chrismalson/Documents/gohustle/src/screens/{TrophyCaseScreen,ReviewsScreen,SavedGigsScreen,FavoritesScreen}.js
  - Four registered, reachable screens whose component names never appear in CLAUDE.md — only their route names inside the nav fence. Each carries behaviour a session would otherwise re-derive or re-break: ReviewsScreen splits history by the review `role` (the two-sided-review model the doc explains elsewhere but never connects to a screen); SavedGigsScreen deliberately KEEPS booked/own gigs in a muted 'closed' group rather than filtering them like Browse does ('a gig silently vanishing here reads as a lost bookmark'); TrophyCaseScreen renders locked badges with live progress. Entry points: ProfileScreen.js:385/502, PublicProfileScreen.js:493, SettingsScreen.js:134/136.

<details><summary>How a test would enumerate this surface</summary>

YES — fully mechanisable, and no existing test covers it (`grep -rn "Key Screens\|src/screens" __tests__/*.js` returns only mfa.test.js and supportIntake.test.js, which read two named files each). Model it on `__tests__/docIndex.test.js`, which does exactly this for root markdown files. Proposed `__tests__/screenIndex.test.js` — four assertions, all runnable today:

```js
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const app    = fs.readFileSync(path.join(ROOT, 'App.js'), 'utf8');

const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name))
                : (e.name.endsWith('Screen.js') ? [path.join(d, e.name)] : []));
const screens = walk(path.join(ROOT, 'src/screens')).sort();          // 32 files today
const names   = screens.map((f) => path.basename(f, '.js'));
const onDisk  = new Set(names);

// (1) every screen file is named somewhere in CLAUDE.md
names.forEach((n) => it(`${n} is described in CLAUDE.md`, () => {
  expect(`${n}: ${claude.includes(n) ? 'documented' : 'UNDOCUMENTED — add it to the Key Screens table'}`)
    .toBe(`${n}: documented`);
}));

// (2) no phantom screens — every `XxxScreen` CLAUDE.md backticks must exist
[...new Set((claude.match(/`([A-Z][A-Za-z]*Screen)`/g) || []).map((s) => s.slice(1, -1)))]
  .forEach((c) => it(`${c} still exists on disk`, () => expect(onDisk.has(c)).toBe(true)));

// (3) every registered route name appears inside the ## Navigation code fence
const fence = claude.split('## Navigation')[1].split('```')[1];
[...new Set([...app.matchAll(/Stack\.Screen name="([A-Za-z]+)"/g)].map((m) => m[1]))]
  .forEach((r) => it(`route ${r} is in the nav tree`, () =>
    expect(new RegExp(`\\b${r}\\b`).test(fence)).toBe(true)));

// (4) every screen file is actually reachable via a registration (gates excepted)
const GATES = new Set(['AuthScreen','OnboardingScreen','ConsentScreen','MfaChallengeScreen']);
names.filter((n) => !GATES.has(n)).forEach((n) => it(`${n} is registered`, () =>
  expect(new RegExp(`component=\\{${n}\\}`).test(app)).toBe(true)));
```

Verified current results by running the same logic: (1) FAILS on 9 screens — AvailabilityScreen, FavoritesScreen, MarketInsightsScreen, NotificationSettingsScreen, NotificationsScreen, PayoutSetupScreen, ReviewsScreen, SavedGigsScreen, TrophyCaseScreen. (2) PASSES — all 23 backticked `*Screen` citations resolve to real files, no phantoms. (3) FAILS on 5 — HomeMain, EarnMain, GigsMain, MessagesMain, ProfileMain. (4) PASSES — all 28 non-gate screens are registered.

Two mechanisation caveats. Reachability (`navigate('X')` existing anywhere) is NOT worth asserting: it would flag ManageBookings, which CLAUDE.md deliberately documents as unreachable — grep it as a one-off (`grep -rn "navigate('ManageBookings'" src/` → 0 hits, claim verified) rather than as a standing test. And assertion (1) is substring-based, so it proves a name is *mentioned*, not that the description is right; the wrong-content drifts below (ProfileScreen's Saved rows) are not mechanisable and need human review.

</details>

## Admin console pages (`admin/app/**`) vs CLAUDE.md and `admin/app/(console)/Nav.tsx`

*Mechanically enumerable: True*

### CLAUDE.md says this, and it is wrong

- **[high]** CLAUDE.md documents the admin console as a surface (CLAUDE.md:256) without listing any of its pages
  - Reality: Only 5 of 17 console routes appear anywhere in CLAUDE.md as paths: /support (:184), /errors (:258), /pricing and /promotions (:494-495), /controls (:526). /categories is named as 'the Categories page' but never as a route. The remaining 11 (/, /access, /audit, /bookings, /disputes, /flags, /jobs, /moderation, /payments, /team, /users) plus four detail pages and one route handler are absent. Nothing in the repo asserts the doc against the filesystem, which is why the drift is this wide.
- **[low]** 47 `controls` run hourly via pg_cron with a daily digest (CLAUDE.md:373)
  - Reality: 49 `ctl_*` functions are defined in supabase/migrations and 49 are registered (counts match, so `adminSurface.test.js`'s orphan check is clean). The doc's 47 is two low. `run_all_controls` also filters out the one `external = true` row, so the number that actually runs in-database is 48. Cosmetic on its own, but it is a count nothing asserts — the same class of drift the controls section itself argues against.
- **[medium]** `__tests__/adminSurface.test.js` fails ... on a console page missing from `Nav.tsx` (CLAUDE.md:257)
  - **CLOSED 2026-08-14** — all four escape hatches below are now covered by
    `__tests__/adminSurface.test.js`, each proved to discriminate by probe: a
    commented-out nav entry now reads as ORPHANED, a nav link to a nonexistent route
    fails naming it, pages outside the route group are enumerated against an expected
    set, and every `route.ts` handler must be listed with what it serves.
  - Reality (as found): TRUE, but one-directional and shallow. Verified: the test exists, runs under `npm test`, and passes today with 19 assertions covering all 16 top-level console directories. It genuinely fails if a new top-level directory under `admin/app/(console)` is not referenced in Nav.tsx. Four real escape hatches: (a) it scans only `admin/app/(console)`, so a page at `admin/app/<x>/page.tsx` is never checked (login/mfa/denied already live there); (b) it enumerates directories, not pages, and ignores `route.ts` handlers entirely — `/users/[id]/export/route.ts` has no coverage; (c) the check is `nav.includes('"/x"')` over the raw file text including comments, so a commented-out nav entry still passes; (d) there is NO reverse check — Nav.tsx may link a route that does not exist and the whole suite stays green, which is exactly the `/reports` 404 that `adminLinks.test.js` was written for, left uncovered on the nav side.
- **[medium]** Nav hides what a role cannot open, but the guard is the enforcement — if they disagree the guard wins (CLAUDE.md:540-541), with admin owning 'everything + team, flags, pricing, promotions' (CLAUDE.md:532)
  - Reality: Nav and the guards agree on 16 of 17 routes. `/flags` diverges: Nav.tsx:76 sets `minRole: "admin"` while flags/page.tsx:18 calls `requireAdminPage("support")`. So every support/trust/finance operator may read the full kill-switch state by URL but cannot discover the page — the opposite of the stated failure direction (nav hiding what a role CAN open, not what it cannot). Writes are correctly `requireFreshAdmin("admin")` (flags/actions.ts:22), so this is a read-visibility split that no comment or doc records.

### Exists, undocumented

- **[high]** `/access — Beta access (the real signup gate)` — /Users/chrismalson/Documents/gohustle/admin/app/(console)/access/page.tsx
  - `beta_allowlist` is a server-side signup gate: `handle_new_user` raises `signup_not_allowlisted` and rolls back the auth.users insert (supabase/migrations/20260710000000_beta_invite_gate.sql). CLAUDE.md's App Flow and AuthContext sections describe sign-up in detail and never mention that signups are allowlist-gated at all, nor that a console page opens/closes the beta by inserting or deleting the '*' row. A session debugging 'sign-up returns an error for a new tester' has no path from CLAUDE.md to the cause, and a session told to 'close the beta' would hand-write SQL in the dashboard — which CLAUDE.md elsewhere forbids.
- **[high]** `/flags — Kill switches` — /Users/chrismalson/Documents/gohustle/admin/app/(console)/flags/page.tsx
  - CLAUDE.md leans on `app_flags` in four separate sections (alert dispatch config, `promotions_enabled`, `bonus_cash_payout_enabled`, and the argument that config-in-a-table 'can be asserted on') but never says a console page reads and toggles them. A session told to pause promotions or the assistant would write SQL rather than use `setFlag` (flags/actions.ts:22, `requireFreshAdmin("admin")` + audit). Worse, the page's own guard is `requireAdminPage("support")` while Nav lists it `minRole: "admin"` — the only nav/guard divergence in the console, and it is in the direction CLAUDE.md does not describe: nav hides a page the role IS allowed to read.
- **[high]** `/bookings and /bookings/[id] — admin lifecycle intervention` — /Users/chrismalson/Documents/gohustle/admin/app/(console)/bookings/[id]/InterventionPanel.tsx
  - bookings/actions.ts exposes forceComplete, reopenBooking, clearStartedAt, forceCancel, releaseHold, recordReversal and refundPayment, all under `requireFreshAdmin("finance")`, writing lifecycle and payment columns directly. CLAUDE.md's Booking Lifecycle section presents the state machine as if edge functions and the two clients were the only writers — yet `ctl_settled_without_captured_payment`'s own body names 'admin forceComplete/reopenBooking write lifecycle columns directly' as a guard bypass. A session changing `guard_bookings_write` or the mutual-completion rule would not know this writer exists.
- **[low]** `/login, /mfa, /denied live outside the (console) route group` — /Users/chrismalson/Documents/gohustle/admin/app/login/page.tsx
  - `adminSurface.test.js` scans only `admin/app/(console)`, so any page added at `admin/app/<x>/page.tsx` is exempt from the nav check entirely — and there is already precedent for putting pages there. The doc's claim that the test catches an orphaned console page is therefore true only inside the route group.
- **[medium]** `/moderation and /disputes — trust queues` — /Users/chrismalson/Documents/gohustle/admin/app/(console)/moderation/page.tsx
  - CLAUDE.md names `resolveReport` and gives trust 'moderation + disputes with resolve authority' but never gives either route. `__tests__/adminLinks.test.js` exists specifically because `safety-alert` linked to `/reports`, which never existed — the queue is `/moderation`. Leaving the route out of the doc is how that bug is written a second time, and it is the one that 404s during a safety incident.
- **[medium]** `/users, /users/[id], and the /users/[id]/export route handler` — /Users/chrismalson/Documents/gohustle/admin/app/(console)/users/[id]/export/route.ts
  - users/[id]/actions.ts carries suspendUser, forceSignOut, setVerified, grantStudent/revokeStudent, changeEmail and deleteAccount (`requireFreshAdmin("admin")`). CLAUDE.md's ID-verification section says only 'Dashboard setup required' and never mentions the manual `setVerified` override, so a session would assume `verified` is Stripe-driven only. Separately, `export/route.ts` is a route handler under a dynamic segment — invisible to `adminSurface.test.js` (which reads top-level directories) and to any `page.tsx` glob, so this PII export path has no structural coverage at all.
- **[medium]** `/payments, /jobs (+/jobs/[id]), /audit, /team, / (Dashboard)` — /Users/chrismalson/Documents/gohustle/admin/app/(console)/payments/page.tsx
  - None of these five routes appear anywhere in CLAUDE.md. /payments is the finance queue (`requireAdminPage("finance")`), /jobs/[id] holds takedown controls (`setJobStatus`, admin-only), /audit is the `admin_audit_log` viewer, /team manages `admin_users` status and role, and / is the metrics dashboard. CLAUDE.md's 'A feature is not finished when the mobile screen works' table instructs every session to ask 'a new object usually needs a page or a column on an existing one' — but gives no inventory of the existing pages to add that column to, so the obligation cannot actually be discharged from the doc.

<details><summary>How a test would enumerate this surface</summary>

FULLY MECHANISABLE — I ran all four checks below against the live tree; results in the findings.

(1) Enumerate console routes (17 today: / /access /audit /bookings /categories /controls /disputes /errors /flags /jobs /moderation /payments /pricing /promotions /support /team /users):
```js
const D = path.join(ROOT, 'admin/app/(console)');
const routes = fs.readdirSync(D, { withFileTypes: true })
  .filter(e => e.isDirectory() && !e.name.startsWith('[') && !e.name.startsWith('_'))
  .filter(e => fs.existsSync(path.join(D, e.name, 'page.tsx')))   // pages, not just dirs
  .map(e => '/' + e.name);
if (fs.existsSync(path.join(D, 'page.tsx'))) routes.unshift('/');
```
Shell equivalent: `find admin/app -name page.tsx -not -path '*/node_modules/*' | sed -e 's|admin/app/(console)||' -e 's|/page.tsx||'`

(2) THE TEST THAT MATTERS — pin CLAUDE.md to that list. Add a console-page table to CLAUDE.md, then:
```js
const doc = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
routes.forEach(r => it(`${r} is documented in CLAUDE.md`, () => {
  expect(`${r}: ${doc.includes('`' + r + '`') ? 'documented' : 'UNDOCUMENTED — add it to the console table'}`)
    .toBe(`${r}: documented`);
}));
```
FAILS TODAY for 11 routes (/access /audit /bookings /disputes /flags /jobs /moderation /payments /team /users, and /categories which is named but never given as a path). That failure is the finding.

(3) Reverse link check — every Nav href resolves to a real page. PASSES today; nothing currently asserts it:
```js
const nav = fs.readFileSync(path.join(D, 'Nav.tsx'), 'utf8');
const hrefs = [...nav.matchAll(/href:\s*"(\/[a-z0-9-]*)"/g)].map(m => m[1]);
hrefs.forEach(h => it(`nav ${h} resolves`, () => expect(routes.includes(h)).toBe(true)));
```

(4) Nav minRole must equal the page's own guard. FAILS TODAY on /flags:
```js
const items = [...nav.matchAll(/\{\s*href:\s*"(\/[a-z0-9-]*)",\s*label:\s*"[^"]+"(?:,\s*minRole:\s*"([a-z]+)")?\s*\}/g)];
items.forEach(([, href, minRole]) => it(`${href} nav tier matches guard`, () => {
  const p = href === '/' ? path.join(D, 'page.tsx') : path.join(D, href.slice(1), 'page.tsx');
  const guard = (fs.readFileSync(p, 'utf8').match(/requireAdminPage\(\s*"([a-z]+)"/) || [])[1] || 'support';
  expect(`${href}: nav=${minRole || 'support'} guard=${guard}`).toBe(`${href}: nav=${guard} guard=${guard}`);
}));
```

(5) Harden the existing test in `__tests__/adminSurface.test.js:47-51`: strip comments before the substring check (`nav.replace(/\/\/[^\n]*/g, '')`), require a `page.tsx` in the directory, and widen the glob to `admin/app/**/page.tsx` so pages added outside the `(console)` route group (where /login, /mfa, /denied already live) are covered.

</details>

## The guard suite — every file in /Users/chrismalson/Documents/gohustle/__tests__/ vs CLAUDE.md's "Definition of done" table (and the three guards named only in CLAUDE.md prose)

*Mechanically enumerable: True*

### CLAUDE.md says this, and it is wrong

- **[high]** The 'Definition of done' table, headed 'this is enforced, not aspirational', presents 9 guard rows as the set of things asserted in __tests__/ — 'anything that must stay true is asserted in __tests__/ and fails loudly'.
  - Reality: 49 suites run. 12 are named anywhere in CLAUDE.md. 19 cross-artifact guards (they read migrations / edge functions / admin actions / screens off disk, so their obligation lives outside the test) are named nowhere, including every money-path source pin, both storage/profile privilege guards, both moderation guards and the migration-naming rule. The table reads as complete and is 12/49.
- **[low]** CLAUDE.md line 15: 'npm test — the pure-logic + drift-guard suite in __tests__/ (~1s)'.
  - Reality: Accurate. Verified: 49 suites, 712 tests, 0.965s, all passing.
- **[low]** Every guard the doc names still exists.
  - Reality: Confirmed — all 12 named files (9 table rows + adminSurface, openWork, docIndex from prose) resolve to real files, and each one's stated purpose matches a real describe block (parity does cover KNOWN_TABS, MUST_KNOW and shared/theme.js vs web/app/globals.css; adminSurface covers the controls registry and Nav.tsx). There are no stale or renamed entries.

### Exists, undocumented

- **[high]** `37 of 49 test suites are named nowhere in CLAUDE.md` — /Users/chrismalson/Documents/gohustle/__tests__/
  - CLAUDE.md names exactly 12 test files: 9 in the Definition-of-done table (parity, categories, pricing, supportGuardDrift, importIntegrity, headerDuplication, assistantGate, ledger, mfa) plus adminSurface (line 257), openWork (line 290) and docIndex (line 300) in prose. The directory holds 49 suites / 712 tests. 19 of the 37 undocumented ones are cross-artifact drift guards that assert against migrations, edge functions and screens — i.e. they encode obligations that live OUTSIDE the test file. A session that reads CLAUDE.md and never opens __tests__/ believes the enforced set is 9 items and will discover the other 40 only when the pre-push hook fails, with no idea what the obligation was.
- **[high]** `storagePolicies.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/storagePolicies.test.js
  - Replays every storage.objects policy across legacy + tracked migrations and asserts NO surviving SELECT policy is bucket-wide and unrestricted (one `for select` governs both download and LIST, and a policy with no `to` clause also grants anon). CLAUDE.md's 'Images (Supabase Storage buckets)' section lists the seven buckets as public/private but never states this rule. A new session adding a bucket copies the 'public read' pattern that made the whole user base harvestable with no account (20260725000000), and only learns at push time.
- **[high]** `profileColumnGrants.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/profileColumnGrants.test.js
  - Asserts (a) date_of_birth stays UNGRANTED on profiles and (b) no client `.from('profiles').select(...)` names a column outside the grant list. CLAUDE.md's 'Supabase Schema Notes' lists profile columns as if they were freely selectable and never mentions the column lockdown, that naming one ungranted column makes PostgREST reject the ENTIRE query with 42501, or that owners read their full row via the my_profile() RPC. This exact gap already caused both Settings screens to load blank and then overwrite the stored profile with empty strings on Save — silent data loss.
- **[high]** `moderationCoverage.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/moderationCoverage.test.js
  - Reconstructs the final effective body of guard_prohibited_content and asserts a fixed column set (jobs text columns incl. location, messages.text, reviews.text, profiles.name/username/bio/work_status_note/city/school/major/skills, bookings.application_note). The obligation — every new user-authored free-text column must be added to the DB backstop — appears nowhere in CLAUDE.md, which mentions the content filter only in passing under the amendment flow.
- **[high]** `moderationSync.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/moderationSync.test.js
  - The prohibited-term blocklist is hand-maintained in THREE copies with no shared import: src/lib/contentFilter.js, the assistant edge function, and the Postgres backstop trigger. CLAUDE.md never says the list is triplicated, so a session adding a term to the client filter ships a moderation gap it has no reason to suspect.
- **[high]** `migrationHygiene.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/migrationHygiene.test.js
  - Asserts no two migration filenames share a 14-digit timestamp and that every filename starts with one. schema_migrations is keyed on the version, so a collision fails db push with an opaque schemal_migrations_pkey error while leaving the state looking APPLIED — a security fix (20260813090000) silently did nothing. CLAUDE.md's migration section covers 'never hand-apply SQL' and the file count but not the naming rule. This test was added 2026-08-13 10:32, after the doc's last edit — live drift.
- **[high]** `address.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/address.test.js
  - Locks maskLocation/canSeeExactAddress against the SQL mirror public.mask_location (20260722040000_mask_job_location_server_side.sql). CLAUDE.md's 'Location, tips & disputes' section describes lat/lng, distance sort and the map but never mentions that exact addresses are masked until a viewer is entitled to them, nor that the helper is duplicated in SQL. A new session renders job.location raw on a new surface and de-masks addresses, and edits one port without the other.
- **[high]** `admin-stepup-reason.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/admin-stepup-reason.test.js
  - Pins five admin server-action files (pricing, flags, bookings, team, users/[id]) to surface AdminAuthError.reason ('stale_mfa') rather than a flat 'Not authorized.', because every caller's UI compares result.message === 'stale_mfa' to open the ReauthPrompt. CLAUDE.md describes requireFreshAdmin/step-up but not this wire contract, so a new admin action dead-ends: the user is refused with no way to learn a code would fix it.
- **[high]** `bookingInsertPins.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/bookingInsertPins.test.js
  - Asserts guard_bookings_write's INSERT branch pins the same server-owned column set as its UPDATE branch (started_at especially — a client-stamped started_at leaves the poster unable to release their own escrow hold for ~7 days). The stated obligation is 'the next column added to the UPDATE pin-list without a matching INSERT pin fails here', and CLAUDE.md's fee-pinning section describes trg_z_pin_booking_amount but never this two-branch rule.
- **[high]** `cancelPaymentContract.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/cancelPaymentContract.test.js
  - Pins the allowed-status arrays in supabase/functions/stripe-cancel-payment/index.ts to those in admin/lib/deleteUser.ts. Without it a poster can void a live escrow hold on a confirmed booking while the booking stays 'confirmed' — the earner works with nothing behind it. CLAUDE.md's lifecycle section says cancelBooking 'releases the escrow hold' but records no contract between the two files.
- **[high]** `escrow-hold-consistency.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/escrow-hold-consistency.test.js
  - Textually pins the single held-amount quantity used in four places inside stripe-create-payment-intent (reconcile comparison, Stripe amount, idempotency key, payments.amount_cents). When poster_discount landed, two of the four were updated and two were not, cancelling live authorizations and locking posters out for 24 hours. CLAUDE.md's money-obligation paragraph asks for a pin and a control but never points at this existing source-level guard.
- **[high]** `tipCaps.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/tipCaps.test.js
  - Asserts stripe-tip checks cumulative caps BEFORE creating the PaymentIntent, and that trg_guard_tip_caps does NOT exempt service_role (tip_ledger is only ever written by a SECURITY DEFINER function invoked with the service key, so the usual service_role early-return idiom would make the trigger a no-op). CLAUDE.md's tips bullet is one line and mentions neither cap nor the inverted guard idiom.
- **[low]** `block.test.js, browseBookable.test.js, goalCard.test.js, transforms.test.js, filters.test.js, badges.test.js, challenges.test.js, certified.test.js, analytics.test.js, finance.test.js, geo.test.js, school.test.js, taxFormat.test.js, age.test.js, availability.test.js, authErrors.test.js, contentFilter.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/
  - Seventeen pure-logic suites over shared/ and src/lib/ helpers. Individually low-stakes for a doc reader, but they are why 'npm test' is meaningful: several encode product rules a session would otherwise re-derive (jobs.status never leaves 'open' so bookability is slot-aware; challenge period keys; badge catalog integrity). Worth one line in CLAUDE.md as a class rather than 17 rows.
- **[medium]** `haptics-usage.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/haptics-usage.test.js
  - Scans src/ and asserts the useHaptic result is only ever used as haptic.<method>(). CLAUDE.md's Haptics section says 'Always use src/hooks/useHaptic.js' without saying it returns an OBJECT, so `haptic('light')` looks correct — that exact call in SafetyBar threw synchronously outside a try and made the SOS button do nothing at all.
- **[medium]** `adminLinks.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/adminLinks.test.js
  - Asserts every ${ADMIN_URL}/<path> an edge function links to corresponds to a real directory under admin/app/(console). safety-alert linked to /reports, which never existed, so the only call-to-action in a harassment/assault page 404'd. CLAUDE.md's 'A feature is not finished' table covers Nav.tsx and the controls registry (adminSurface) but not outbound links from edge functions.
- **[medium]** `supportIntake.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/supportIntake.test.js
  - Pins ProfileScreen / SettingsScreen / PayoutSetupScreen to the in-app support form and forbids mailto:. Before it, no TestFlight tester's request could enter support_tickets at all while the console queue showed empty. CLAUDE.md's Support section warns against a second SupportScreen but never says mailto: is banned in the entry points.
- **[medium]** `safety-guards.test.js and safetyAlert.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/safety-guards.test.js
  - safety-guards pins the SOS rate-limit exemption to the app.emergency GUC rather than new.source (trigger fire order is alphabetical, so new.source still held client input and any user could set source='emergency' to skip the 10/hour limit, with the later trigger rewriting the column so nothing recorded the skip). safetyAlert pins the AFTER INSERT pg_net dispatch and its fail-open behaviour. Both are unmentioned; CLAUDE.md points at RUNBOOK_SAFETY.md but not at the assertions that keep the path alive.
- **[medium]** `anonRevoke.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/anonRevoke.test.js
  - Asserts REVOKE SELECT ON public.profiles/jobs FROM anon survives in the tracked migrations, and that the prereq DDL is ordered before the column lockdown. CLAUDE.md never mentions that anon read was revoked, so a session debugging a 'why can't an unauthenticated fetch see jobs' question could plausibly re-grant it.
- **[medium]** `jobPay.test.js / earnerClaim.test.js / moneyFormatterWiring.test.js` — /Users/chrismalson/Documents/gohustle/__tests__/jobPay.test.js
  - Three contracts CLAUDE.md omits entirely: a $10 MIN_JOB_PAY floor routed through shared validateJobPay in four places incl. server-side (a new post flow that skips it diverges mobile/web/server); EARNER_CLAIM_GRACE_DAYS = 3 for claimEarnerPayment (the lifecycle section describes the claim but not the window); and that src/lib/finance.js is a bare `export *` of shared/finance.js whose formatMoney re-export has already resolved to undefined and crashed JobCard and EarningsTiles on device.

<details><summary>How a test would enumerate this surface</summary>

Fully mechanisable, and the repo already contains the exact precedent: __tests__/docIndex.test.js does this for root markdown files. Mirror it for the guard suite.

SHELL (the diff as run today — prints the 37 undocumented files):
  cd /Users/chrismalson/Documents/gohustle
  for f in $(ls __tests__/*.test.js | xargs -n1 basename); do grep -q "$f" CLAUDE.md || echo "UNDOCUMENTED $f"; done
Reverse direction (a named guard that no longer exists — currently clean):
  for f in $(grep -o '[A-Za-z0-9._-]*\.test\.js' CLAUDE.md | sort -u); do [ -f "__tests__/$f" ] || echo "GONE $f"; done

PROPOSED TEST — /Users/chrismalson/Documents/gohustle/__tests__/guardIndex.test.js

  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  const tests = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js') && f !== 'guardIndex.test.js');

  // A guard whose obligation lives OUTSIDE the test file — it asserts against a
  // migration, an edge function, an admin action or a screen. Those are the ones a
  // session must be told about, because the thing they constrain is not in __tests__/.
  // Pure-logic suites over shared/ helpers are exempt: reading the helper tells you the rule.
  const crossArtifact = tests.filter((f) =>
    /require\(['\"]fs['\"]\)|from ['\"]fs['\"]/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));

  describe('every cross-artifact guard is discoverable from CLAUDE.md', () => {
    it('finds guards to check (guards the heuristic itself)', () => {
      expect(crossArtifact.length).toBeGreaterThan(20);
    });
    crossArtifact.forEach((f) => {
      it(`${f} is documented`, () => {
        expect(`${f}: ${claude.includes(f) ? 'documented' : 'UNDOCUMENTED — add a row to the Definition of done table'}`)
          .toBe(`${f}: documented`);
      });
    });
  });

  describe('CLAUDE.md never names a guard that does not exist', () => {
    const named = [...new Set(claude.match(/[A-Za-z0-9._-]+\.test\.js/g) || [])];
    it('finds names to check', () => expect(named.length).toBeGreaterThan(5));
    named.forEach((f) => {
      it(`${f} exists`, () => {
        expect(`${f}: ${fs.existsSync(path.join(__dirname, f)) ? 'exists' : 'MISSING — deleted or renamed, fix the table'}`)
          .toBe(`${f}: exists`);
      });
    });
  });

State today: tier 1 fails with 19 named offenders (admin-stepup-reason, adminLinks, anonRevoke, block, bookingInsertPins, cancelPaymentContract, earnerClaim, escrow-hold-consistency, haptics-usage, migrationHygiene, moderationCoverage, moderationSync, moneyFormatterWiring, profileColumnGrants, safety-guards, safetyAlert, storagePolicies, supportIntake, tipCaps); tier 2 passes.

Heuristic notes (state them in the test's comment header so the next editor does not weaken it):
- 31 of 49 suites require fs; 12 of those are already documented, so the predicate partitions cleanly rather than flagging everything.
- Two known false POSITIVES are still correct to include: block.test.js and earnerClaim.test.js are hybrids that also assert against migrations.
- One known false NEGATIVE: address.test.js is pure JS but mirrors public.mask_location in SQL. Either widen the predicate to /migration|supabase\/functions|mirror/i over the file's comment header, or keep an explicit ALWAYS_DOCUMENT = ['address.test.js'] list.
- Bar is 'named anywhere in CLAUDE.md' (matching docIndex.test.js). A stricter variant — parse the rows between the `| Guard | Stops |` header and the next `##` and require membership in that table — is a one-line change and would additionally flag adminSurface/docIndex/openWork, which are documented only in prose; adopt it only after those three get table rows.

</details>

## Edge functions (`supabase/functions/`) — 32 deployable function directories + `_shared/`, checked against every mention in CLAUDE.md

*Mechanically enumerable: True*

### CLAUDE.md says this, and it is wrong

- **[high]** CLAUDE.md line 258 ('A feature is not finished…' table, Errors row): 'New edge functions should `console.error` on failure; nothing else surfaces them.'
  - Reality: False since `supabase/functions/_shared/logError.ts` landed. `logServerError(fn, message, context, { fatal, userId })` inserts into the SAME `client_errors` table the console renders at /errors, tagged `platform='edge'` with the function name in `app_version`. Six functions already use it (accept-booking, admin-payment-action, earner-claim-payment, stripe-capture-payment, stripe-create-payment-intent, stripe-tip). The file's own header says console.error was the problem, not the answer: 'Supabase function logs exist, but nobody watches them, they are not searchable next to the rest of the console.' A session obeying CLAUDE.md writes a money function whose failures never appear on the errors board.
- **[high]** Pre-push hook section: '`supabase/functions/` changed → deploy each one by hand', with no further qualification anywhere in CLAUDE.md.
  - Reality: Seven functions are unreachable if deployed with the gateway default. `supabase/config.toml` carries `verify_jwt = false` for stripe-webhook, stripe-identity-return, stripe-connect-return, support-submit, safety-alert, controls-alert and reconcile-stripe, and its own comment warns that a plain deploy without those entries 'silently kills the alerting channel — and the control below would be the only thing that ever noticed.' CLAUDE.md never mentions `supabase/config.toml`, `verify_jwt`, or `--no-verify-jwt` (grep count: 0).
- **[low]** 'The other documents in this repo' table, plus `__tests__/docIndex.test.js`, presented as the mechanism that stops project docs being orphaned.
  - Reality: docIndex.test.js scans the repo ROOT only (`fs.readdirSync(ROOT).filter(f => f.endsWith('.md'))`), so `supabase/AI_ASSISTANT.md` and `supabase/STUDENT_VERIFICATION.md` — the two documents covering the assistant and the student-verification edge functions — are permanently invisible to it and unreferenced by CLAUDE.md. The anti-orphan guarantee does not extend to the edge-function surface.
- **[medium]** Two-factor section: 'Step-up (`_shared/stepUp.ts`): minting a Stripe payout dashboard link or starting Connect onboarding requires aal2.'
  - Reality: Accurate in substance but unresolvable to files — the two functions are `stripe-payout-login-link` and `stripe-connect-onboard`, neither named anywhere in CLAUDE.md. Worse, step-up in the edge layer is now TWO different mechanisms: `_shared/stepUp.ts` (`requireStepUp`, user-facing payout paths) and `_shared/adminAuth.ts` (`requireAdminCaller(req, role, maxMfaAgeSeconds)`, amr-timestamp-based, used by admin-payment-action at 300s). CLAUDE.md documents only the first and attributes admin step-up entirely to `admin/lib/guard.ts`.
- **[medium]** Admin console roles: 'Four ranked tiers (`admin/lib/guard.ts`, `roleSatisfies`): support · trust · finance · admin.'
  - Reality: True for the console, but the edge-function layer implements only two: `_shared/adminAuth.ts` exports `type AdminRole = 'admin' | 'support'`. Nothing in CLAUDE.md warns that `trust` and `finance` do not exist server-side, so a session gating a new edge function at `finance` (the tier CLAUDE.md assigns to 'payments, refunds, escrow') writes a role the shared gate cannot satisfy.
- **[medium]** ID verification section: 'Dashboard setup required: enable Stripe Identity on the account and register the three `identity.verification_session.*` webhook events.' Transactions section: 'Requires `payout.created/updated/paid/failed/canceled` enabled on the Connect webhook.'
  - Reality: A partial provisioning checklist presented as complete. `supabase/functions/stripe-webhook/index.ts` also handles `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `account.updated`, `charge.dispute.created` and `charge.refunded` — six further events CLAUDE.md never asks anyone to register. Provisioning a Stripe account from CLAUDE.md alone enables 8 of the 14 events the handler expects, and the missing ones include the entire escrow settlement and dispute path.

### Exists, undocumented

- **[high]** `stripe-create-payment-intent` — /Users/chrismalson/Documents/gohustle/supabase/functions/stripe-create-payment-intent/index.ts
  - 459 lines — the function that MINTS the escrow authorization (manual-capture PaymentIntent) when a poster accepts. CLAUDE.md's entire 'Platform fee, promotions & incentives' section describes fee pinning, lowest-wins bps and idempotent capture, and names `stripe-capture-payment` — but never the function that creates the hold in the first place. It also carries `safeBps()`, a hand-written guard whose comments record two prior money bugs (Number(null)===0 resolving a NULL rate to a free gig; `n > 0` mapping a legitimately-pinned 0 bps promotion to the 1000 fallback and charging full fee). A session told to 'change how the hold is created' cannot find this file from CLAUDE.md and would not know the safeBps invariant exists.
- **[high]** `admin-payment-action` — /Users/chrismalson/Documents/gohustle/supabase/functions/admin-payment-action/index.ts
  - Its own header calls it "THE console's only path to moving money" — `release_hold` (void an uncaptured auth) and `refund` (full/partial). It enforces `requireAdminCaller(req, 'admin', 300)` — admin tier AND a 300-second step-up — independently of the console. CLAUDE.md's 'Admin console roles' section describes step-up only as `requireFreshAdmin` in `admin/lib/guard.ts`, so a session reading it believes step-up is a console-side concern. A refund feature added elsewhere, or a change to the console guard, would miss that the real gate lives here. Also records that a Stripe Dashboard capture silently desyncs the ledger — an operational fact recorded nowhere in CLAUDE.md or RUNBOOK_MONEY's index entry.
- **[high]** `delete-account` — /Users/chrismalson/Documents/gohustle/supabase/functions/delete-account/index.ts
  - Apple 5.1.1(v) / Play / GDPR account deletion, called from `src/screens/ProfileSettingsScreen.js` and `web/app/(app)/profile/settings/page.tsx`. It hardcodes a `BUCKETS` list of all seven storage buckets because buckets do not FK-cascade, and it refuses deletion while a booking is `confirmed`/`completed` (money in flight). CLAUDE.md's 'Images (Supabase Storage buckets)' section lists all seven buckets and never says that adding an eighth obliges you to edit this file — which is exactly the defect the file's own comment records (`certificates` was missing, leaving public credential-scan URLs fetchable after the account was gone).
- **[high]** `stripe-cancel-payment` — /Users/chrismalson/Documents/gohustle/supabase/functions/stripe-cancel-payment/index.ts
  - CLAUDE.md says `cancelBooking` 'releases the escrow hold' and the lifecycle diagram says cancelling 'releases the escrow hold', but never names the function that does it. There is a dedicated test for its contract (`__tests__/cancelPaymentContract.test.js`) that a session would not know to run. Getting release wrong means a poster's card stays authorized on a dead booking.
- **[high]** `stripe-connect-onboard` — /Users/chrismalson/Documents/gohustle/supabase/functions/stripe-connect-onboard/index.ts
  - CLAUDE.md's two-factor section says step-up applies to 'starting Connect onboarding' but names no function. This is it — it imports `requireStepUp` from `_shared/stepUp.ts` and `deriveConnectStatus` from `_shared/connectStatus.ts`. CLAUDE.md separately warns that 'Adding step-up to payouts broke payout setup for every user' as a blast-radius parable, but a session cannot locate the file that broke without grepping. It also sets `return_url` to the web app, which is why `stripe-connect-return` still exists as a 302 backstop.
- **[high]** `stripe-payout-login-link` — /Users/chrismalson/Documents/gohustle/supabase/functions/stripe-payout-login-link/index.ts
  - The other half of the step-up pair CLAUDE.md describes by behaviour only ('minting a Stripe payout dashboard link ... requires aal2'). Grepping CLAUDE.md for 'payout dashboard' finds prose with no path. This is the function that hands an earner a single-use Express dashboard link to their bank details — the highest-value non-money action in the app.
- **[high]** `safety-alert` — /Users/chrismalson/Documents/gohustle/supabase/functions/safety-alert/index.ts
  - CLAUDE.md's Controls section uses `trg_notify_safety_report` sitting dead from 2026-07-10 to 2026-08-06 as the argument for keeping alert config in `app_flags` — but never names the function the trigger dispatches to. It is invoked by the reports AFTER INSERT trigger via pg_net with an `x-safety-secret` shared secret (`SAFETY_ALERT_SECRET`, must match the `app.safety_alert_secret` GUC), requires `verify_jwt = false`, and needs `SAFETY_ONCALL_EMAIL` + `RESEND_API_KEY`. `RUNBOOK_SAFETY.md` is indexed in CLAUDE.md but the function it depends on is not. A session redeploying functions without `supabase/config.toml` re-enables JWT verification and silently kills safety paging again.
- **[high]** `supabase/config.toml (verify_jwt registry)` — /Users/chrismalson/Documents/gohustle/supabase/config.toml
  - CLAUDE.md never mentions this file, yet it is the ONLY record of the seven functions that must be reached without a Supabase JWT: stripe-webhook, stripe-identity-return, stripe-connect-return, support-submit, safety-alert, controls-alert, reconcile-stripe. The pre-push hook reminder CLAUDE.md quotes — '`supabase/functions/` changed → deploy each one by hand' — is actively dangerous without it: config.toml's own comment says 'Without this line the next plain `supabase functions deploy` re-enables JWT verification and silently kills the alerting channel'. config.toml also documents WHY support-reply/support-ai-draft are deliberately absent (admin user JWT + in-function `requireAdminCaller`), and that 'There is no x-admin-secret / service-role-header mechanism — that never existed.' All of this is invisible to a session that only reads CLAUDE.md.
- **[high]** `_shared/logError.ts (logServerError)` — /Users/chrismalson/Documents/gohustle/supabase/functions/_shared/logError.ts
  - This is the direct counter-example to CLAUDE.md's own instruction (see the in_doc_not_in_code entry). It writes edge failures into the same `client_errors` table the console renders at /errors, tagged `platform='edge'`, `app_version=<fn>`, with a `fatal` flag. Six functions already adopt it: accept-booking, admin-payment-action, earner-claim-payment, stripe-capture-payment, stripe-create-payment-intent, stripe-tip. A new money function written to CLAUDE.md's letter would `console.error` and be invisible on the errors board — the precise failure the file was written to fix ('the poster pressed pay and it silently didn't work' was invisible until someone complained).
- **[high]** `support-reply` — /Users/chrismalson/Documents/gohustle/supabase/functions/support-reply/index.ts
  - CLAUDE.md's Support section covers `src/lib/support.js`, the tables, the guard exemption and `openThreadWithUser` — and names zero edge functions. This one carries a hard security invariant in its header: THE RECIPIENT IS RESOLVED SERVER-SIDE, NEVER TAKEN FROM THE REQUEST, because it previously read `toEmail` from the body and was 'a phishing relay wearing our own brand' sending from support@gohustlr.com. It is tier-gated 'support' for the ticket branch and 'admin' for the no-ticket branch. CLAUDE.md says agent cold contact is 'in-app + push only (never branded email)' but does not point at the function that enforces it.
- **[high]** `moderate-text` — /Users/chrismalson/Documents/gohustle/supabase/functions/moderate-text/index.ts
  - Claude-backed (claude-haiku-4-5) context-aware moderation called BEFORE writing user text from PostJobScreen, EditJobScreen and `src/lib/moderation.js`. CLAUDE.md alludes to it once, obliquely — 'Returns false if the note trips the prohibited-content filter' — and otherwise only names the DB keyword trigger. Critically it FAILS OPEN by design; a session that assumes the filter is authoritative would mis-model the safety posture. On a block it also auto-files a report into the admin Moderation queue.
- **[low]** `log-moderation` — /Users/chrismalson/Documents/gohustle/supabase/functions/log-moderation/index.ts
  - Fire-and-forget from `src/lib/moderation.js`; records client-detected keyword blocks into the admin Moderation queue as `reports` with `source='auto'`, rate-limited so a user probing the filter cannot flood the queue. CLAUDE.md's 'A feature is not finished when the mobile screen works' table asks 'can a human see and act on this' — this is the answer for moderation, and it is unnamed.
- **[low]** `stripe-detach-payment-method` — /Users/chrismalson/Documents/gohustle/supabase/functions/stripe-detach-payment-method/index.ts
  - The 'Remove card' action in the Payments hub. Minor, but it is part of the saved-card lifecycle a session would otherwise reimplement.
- **[low]** `stripe-connect-return` — /Users/chrismalson/Documents/gohustle/supabase/functions/stripe-connect-return/index.ts
  - A 14-line 302 backstop that looks deletable and is not — it exists only so Connect sessions created BEFORE the return_url moved to the web app still land correctly. Its header records the real constraint: the Edge Functions gateway forces text/plain + nosniff on browser responses, so HTML served from an edge function renders as raw source. That is a reusable platform fact (it also explains `stripe-identity-return`) that a session would rediscover the hard way.
- **[low]** `_shared/connectStatus.ts (deriveConnectStatus)` — /Users/chrismalson/Documents/gohustle/supabase/functions/_shared/connectStatus.ts
  - The single definition of Connect payout-account state, shared by stripe-connect-onboard and stripe-connect-status, and mirrored client-side in `src/lib/connectStatus.js`. Two copies of a state derivation with no drift guard, neither mentioned in CLAUDE.md.
- **[medium]** `moderate-image` — /Users/chrismalson/Documents/gohustle/supabase/functions/moderate-image/index.ts
  - 216 lines, called from `src/lib/uploadImage.js` — i.e. EVERY image upload path in the app passes through it. CLAUDE.md's 'Images (Supabase Storage buckets)' section says 'All writes ... go through `src/lib/uploadImage.js`' and stops there, so a session adding a new upload surface has no idea image moderation is part of that contract.
- **[medium]** `support-submit` — /Users/chrismalson/Documents/gohustle/supabase/functions/support-submit/index.ts
  - Public intake with `verify_jwt = false` — the website Contact form and `SupportScreen`/`src/lib/support.js` both POST here. It creates the ticket + first message and emails via Resend, rate-limited by email, with `SUPPORT_ONCALL_EMAIL` as the routable destination. It has its own test (`__tests__/supportIntake.test.js`). CLAUDE.md's Support section reads as if tickets are created by direct table writes under owner RLS, which is wrong for the unauthenticated path.
- **[medium]** `support-ai-draft` — /Users/chrismalson/Documents/gohustle/supabase/functions/support-ai-draft/index.ts
  - Drafts support replies with Claude from the admin console, gated at 'support' tier via `requireAdminCaller`. Its header notes the tier matters because it ships ticket PII to a third-party LLM. CLAUDE.md never mentions that support ticket contents leave the platform — a privacy fact a session touching support or writing the privacy doc needs.
- **[medium]** `stripe-connect-status` — /Users/chrismalson/Documents/gohustle/supabase/functions/stripe-connect-status/index.ts
  - Live-retrieves the Connect account from Stripe and syncs `stripe_accounts.onboarded`, because `account.updated` is a Connected-accounts-scope event a platform's normal webhook never receives — so the cached flag could be stuck false forever. Its header states the blast radius explicitly: a stuck flag makes stripe-create-payment-intent / capture / tip all reject the earner with EARNER_NO_PAYOUT, blocking the whole escrow flow. That is a top-tier 'why is booking broken' diagnosis and it is nowhere in CLAUDE.md.
- **[medium]** `student-verify-confirm` — /Users/chrismalson/Documents/gohustle/supabase/functions/student-verify-confirm/index.ts
  - Flips `profiles.student_verified` (service-role only; a DB trigger blocks clients self-setting it) and records the verified school domain. CLAUDE.md mentions student verification twice in passing (ProfileScreen 'identity + student verification', and `student-verify-start` only as a hotlinker of the wordmark PNG) and never describes the flow or the trigger-enforced write restriction. `supabase/STUDENT_VERIFICATION.md` documents it but is not in CLAUDE.md's document map.
- **[medium]** `stripe-create-setup-intent` — /Users/chrismalson/Documents/gohustle/supabase/functions/stripe-create-setup-intent/index.ts
  - Saves a card on file BEFORE a poster accepts a booking — the prerequisite for the escrow auth and for `stripe-tip`'s off-session charge, which CLAUDE.md does describe ('off-session charge → earner') without saying where the off-session-capable payment method comes from. Its header notes it mirrors the customer get-or-create logic in stripe-create-payment-intent, i.e. two places to keep in step.
- **[medium]** `stripe-payment-method-status` — /Users/chrismalson/Documents/gohustle/supabase/functions/stripe-payment-method-status/index.ts
  - Gates booking acceptance on whether the poster has a saved card, and drives the 'add a payment method' prompts. CLAUDE.md's lifecycle says accept 'confirms ONLY if a real Stripe escrow hold exists' but never mentions the pre-check that stops a poster reaching accept without a card.
- **[medium]** `_shared/adminAuth.ts (requireAdminCaller)` — /Users/chrismalson/Documents/gohustle/supabase/functions/_shared/adminAuth.ts
  - The shared admin gate for every console-called edge function (support-reply, support-ai-draft, admin-payment-action, send-push's adminNotice). It exports `type AdminRole = 'admin' | 'support'` — only TWO tiers, whereas CLAUDE.md documents four ranked tiers (`support` < `trust`/`finance` < `admin`). A session adding a `finance`- or `trust`-gated edge function would pass a role string this module cannot satisfy. It also implements the amr-based MFA-age step-up (`maxMfaAgeSeconds`, FAILS CLOSED) that CLAUDE.md attributes solely to `admin/lib/guard.ts`, and records the historical hole: the per-function copies checked `admin_users` MEMBERSHIP only, so a support-tier token could do admin-tier work by POSTing the function directly.

<details><summary>How a test would enumerate this surface</summary>

YES — and there is already a working template for it in the repo: `__tests__/docIndex.test.js` does exactly this shape for root markdown files. The edge-function equivalent is `__tests__/edgeFunctionIndex.test.js`:

```js
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const FN_DIR = path.join(ROOT, 'supabase', 'functions');

// `_shared` is a module directory, not a deployable function.
const fns = fs.readdirSync(FN_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== '_shared')
  .map((d) => d.name)
  .sort();

describe('every edge function is discoverable from CLAUDE.md', () => {
  it('finds functions to check', () => expect(fns.length).toBeGreaterThan(20));
  fns.forEach((fn) => {
    it(`${fn} is named in CLAUDE.md`, () => {
      expect(`${fn}: ${claude.includes(fn) ? 'documented' : 'UNDOCUMENTED — name it in CLAUDE.md'}`)
        .toBe(`${fn}: documented`);
    });
  });
});
```

A plain `claude.includes(name)` is safe here — I verified no function name is a prefix or substring of another (`stripe-connect-onboard`/`-return`/`-status`, `stripe-create-payment-intent`/`-setup-intent`/`-identity-session`, `student-verify-start`/`-confirm`, `support-reply`/`-submit`/`-ai-draft`, `stripe-capture-payment`/`stripe-cancel-payment` are all mutually non-containing), so there are no false passes.

Dry-run result today: 32 functions, 13 named in CLAUDE.md, **19 fail**.

Shell equivalent for a one-off check:
`ls -1 supabase/functions | grep -v '^_' | while read n; do grep -q -- "$n" CLAUDE.md || echo "UNDOCUMENTED: $n"; done`

Two companion assertions worth putting in the same file, both mechanical:

1. **The verify_jwt registry must be documented and must not drift.** `supabase/config.toml` is the only record of which functions are reached without a Supabase JWT, and CLAUDE.md never mentions the file:
```js
const toml = fs.readFileSync(path.join(ROOT, 'supabase', 'config.toml'), 'utf8');
const noJwt = [...toml.matchAll(/^\[functions\.([a-z0-9-]+)\]/gm)].map((m) => m[1]);
noJwt.forEach((fn) => {
  it(`${fn} (verify_jwt=false) exists on disk`, () => expect(fns).toContain(fn));
});
it('CLAUDE.md points at the verify_jwt registry', () =>
  expect(claude).toMatch(/supabase\/config\.toml/));
```

2. **The edge error-sink convention.** `_shared/logError.ts` exists and CLAUDE.md still tells new sessions to `console.error`:
```js
it('CLAUDE.md names the edge error sink, not console.error', () => {
  expect(claude).toMatch(/_shared\/logError\.ts|logServerError/);
  expect(claude).not.toMatch(/New edge functions should `console\.error` on failure; nothing else surfaces them/);
});
```

What CANNOT be mechanised: whether the *description* of a named function is accurate (e.g. that `stripe-capture-payment` does partial capture). The glob only proves the name appears somewhere. That is still the right trade — 19 of 32 functions are not named at all, and 8 of those move money or gate auth.

</details>

## shared components — /Users/chrismalson/Documents/gohustle/src/components/ (34 files) vs CLAUDE.md "Key Components" (14 bullets) + the component references scattered through the Images / Location / Messages-hub sections

*Mechanically enumerable: True*

### CLAUDE.md says this, and it is wrong

- **[high]** **`MessageSheet`** — Props: `bookingId`, `jobTitle`, `otherPerson: { name, avatarInitial }`, `onClose`.
  - Reality: Actual signature (src/components/MessageSheet.js:30): `{ visible, bookingId, jobId, jobTitle, otherPerson, onClose, onViewProfile, onViewJob, embedded = false }`. (1) `visible` is MANDATORY — line 329 is `if (!visible) return null;` and the load effect bails at line 104 (`if (!visible || !bookingId)`), so a host built from the documented list renders nothing at all. (2) `otherPerson`'s real shape is `{ id, name, avatarInitial, avatarUrl }`; the undocumented `id` is what drives report (line 49, `submitReport({ reportedUserId: otherPerson?.id })`), block (line 58), the recipient of every chat push (lines 259 and 287) and the tap-through to UserProfile (lines 363-369) — with the documented two-key shape all four silently no-op, including the push notification. (3) `jobId` + `onViewJob` are what make the 're: job' line tappable and `onViewProfile` the header person — the exact behaviours CLAUDE.md's own Messages-hub paragraph promises. (4) `embedded` is how ChatScreen hosts it full-screen (src/screens/ChatScreen.js:110).
- **[high]** **`CompletionModal`** — poster "Verify & Rate" bottom sheet. Props: `booking`, `onConfirm({ rating, reviewText, paymentMethod })`.
  - Reality: Actual signature (src/components/CompletionModal.js:47): `{ visible, booking, onClose, onConfirm }` — `visible` and `onClose` are required and undocumented. The onConfirm payload (lines 102-108) is `{ rating, reviewText, paymentMethod: 'card', tipCents, pct, disputeReason, disputePhotos }`. The documented payload drops exactly the money-bearing fields: `tipCents` (the tip charge) and `pct` + `disputeReason` (the partial-capture / dispute path) — the same two flows CLAUDE.md's own 'Location, tips & disputes' section says route through this modal into `verifyAndRate`. A handler written to the documented shape silently discards tips and pays 100% on a disputed job. onConfirm's return value is also load-bearing and undocumented: an explicit `false` means abort and keep the sheet open (line 112).
- **[high]** **`RatingStars`** — reusable star rating display/input component.
  - Reality: It is display-ONLY. `RatingStars({ rating, size = 13 })` (src/components/RatingStars.js:5) renders a single ★ glyph plus `rating.toFixed(1)`; there is no value/onChange/editable prop and no 5-star row. All 10 call sites pass `rating` + `size`. The actual rating INPUT is a local `StarPicker` defined inside CompletionModal.js:24 and a hand-rolled `starRow` in EarnScreen.js:841. A session building the next rating flow reaches for RatingStars per this line and gets an unresponsive read-only badge. `rating` is also required and must be a number — `rating.toFixed(1)` throws on null/undefined, which is why callers write `Number(p.rating) || 0` (FindPeopleScreen.js:126) or ternary-guard it (PublicProfileScreen.js:225).
- **[high]** **`FilterSheet`** — bottom-sheet modal with sort, pay range, pay type, available days (parsed from slot labels), location/state chips, urgency toggle. Import `DEFAULT_FILTERS` and `countActiveFilters` from it.
  - Reality: Props are undocumented and non-obvious: `{ visible, filters, availableStates, mySchool, defaultCenterLabel, onApply, onClose }` (FilterSheet.js:35). Two whole sections are missing from the description: **Distance** (radius from a center, `RADIUS_OPTIONS` + `filters.near`, lines 149-176) and **Trust** (`verifiedStudentsOnly`, `campusOnly` gated on `mySchool`, lines 231-264). More importantly the import advice points at the wrong file: FilterSheet.js:16 only RE-exports them (`export { DEFAULT_FILTERS, countActiveFilters } from '../lib/filters'`), src/lib/filters.js is `export * from '../../shared/filters.js'`, and the real contract — including `applyJobFilters`, which is what the browse feed and web /browse actually apply — lives in shared/filters.js. Adding a filter key to the sheet alone ships a control that silently does nothing; the code comment at FilterSheet.js:13-15 exists because of this. Importing from FilterSheet also drags a react-native component into any shared/web consumer.
- **[low]** **`Avatar`** — Props `{ url, initial, size, bg, fontSize, borderColor, borderWidth, style }`.
  - Reality: The list presents itself as complete but omits `textColor = '#fff'` (src/components/Avatar.js:13). Minor, but it is the one prop you need when placing the fallback circle on a light background.
- **[low]** **`SlotPicker`** — single-select chip row from existing `slots[]` (used in JobDetail).
  - Reality: Also honours `slot.taken`, which disables the chip and swaps it to a lock-icon/greyed style (src/components/SlotPicker.js:20-31, 61). A slot data shape built without `taken` renders every already-booked slot as bookable.
- **[medium]** **`BadgeGrid`** / **`ChallengeCard`** — achievement and challenge display in ProfileScreen.
  - Reality: `src/components/ChallengeCard.js` has zero importers anywhere under src/ or App.js — it is dead on mobile. The mobile ProfileScreen renders `GoalsChallengesCard` (whose `ChallengesList` does the job) plus `MoneyGoalCard` and `MonthSummaryCard`. The live `ChallengeCard` is the WEB one, web/components/ChallengeCard.tsx, used by web/app/(app)/profile/page.tsx:371. BadgeGrid ({ badges, onPressAll }) is correct.
- **[medium]** `completion-photos` … Render with `<SignedImage bucket="completion-photos" …>` (and the same line for `support-photos`).
  - Reality: The content prop is never named. It is `value` — `SignedImage({ value, bucket, style })` (src/components/SignedImage.js:11) — and `value` is a bare object path (`<uid>/<file>`) or a legacy full public URL, not a URI. Every call site passes `value={u}`. Getting the prop name wrong fails SILENTLY: `if (!uri) return <View …grey placeholder…>` with no throw, no console warning, and no network request, so a private-bucket image just renders as a permanent grey box.

### Exists, undocumented

- **[high]** `SafetyBar` — /Users/chrismalson/Documents/gohustle/src/components/SafetyBar.js
  - The entire live-gig safety surface, and CLAUDE.md has ZERO mentions of it — grep for SafetyBar, gig_shares, create_gig_share, raise_gig_emergency or the /s/ route in CLAUDE.md returns 0 hits. It renders at /Users/chrismalson/Documents/gohustle/src/screens/EarnScreen.js:490 on a started booking and does two things: `supabase.rpc('create_gig_share', {p_booking, p_hours})` mints a server-side token that becomes a PUBLIC page at gohustlr.com/s/<token> exposing the gig's street address and the earner's live status (web/app/s/[token]/page.tsx), and `supabase.rpc('raise_gig_emergency', {p_booking, p_note})` is an SOS that pages the safety team. Eight migrations back it (20260806180000_gig_safety.sql, 20260806190000_safety_share_disclosure.sql, 20260806200000_safety_fixes.sql, 20260806210000_share_retarget_fix.sql, 20260806290000_emergency_exemption_bypass.sql, 20260806300000_share_token_hardening.sql, plus the two safety_report_* files). A new session touching the booking-started path, the earner hub, or share-token lifetime cannot know any of it exists, and CLAUDE.md's own 'a feature is not finished when the mobile screen works' table would never be applied to it.
- **[high]** `FloatingTabBar` — /Users/chrismalson/Documents/gohustle/src/components/FloatingTabBar.js
  - The tab bar is fully custom — App.js:205 passes `tabBar={(props) => <FloatingTabBar {...props} />}` — and it collapses/expands on scroll via /Users/chrismalson/Documents/gohustle/src/lib/tabBarScroll.js. CLAUDE.md's Navigation ASCII shows a bare `Tab.Navigator (5 tabs …)` and lists no custom tabBar, so a session changing a tab label, icon, or the badge rendering edits `screenOptions` / `tabBarBadge` and nothing happens on screen. It also owns the focused-route and keyboard logic per its own comments.
- **[low]** `TagInput / WorkStatusBar / Logo` — /Users/chrismalson/Documents/gohustle/src/components/TagInput.js, WorkStatusBar.js, Logo.js
  - TagInput is the editor for `jobs.tags` and enforces the max-6 cap (`max = 6` default) that CLAUDE.md states as a schema fact without saying where it is enforced client-side. WorkStatusBar is the ready-to-work/busy/away/offline toggle driven by `useUser().workStatus` / `setWorkStatus` — neither of which appears in CLAUDE.md's UserContext key-exports list. Logo has a light/mark/lockup prop matrix used by AuthScreen. All three are re-implementation bait.
- **[medium]** `KeyboardDoneBar (and the exported KEYBOARD_DONE_ID)` — /Users/chrismalson/Documents/gohustle/src/components/KeyboardDoneBar.js
  - Ten screens import it (PostJob, EditJob, JobDetail, Earn, Gigs, Expenses, Settings, ProfileSettings, FindPeople, Onboarding). It is a two-part contract nobody can infer: render `<KeyboardDoneBar />` once in the screen AND pass `inputAccessoryViewID={KEYBOARD_DONE_ID}` on the input. Multiline and numeric/decimal-pad inputs have no return key on iOS, so a new text/amount field added without it strands the keyboard over the screen — the exact beta-tester bug the file's header comment records. CLAUDE.md never names it.
- **[medium]** `MonthSummaryCard` — /Users/chrismalson/Documents/gohustle/src/components/MonthSummaryCard.js
  - It has NO default export — only the named `EarningsTiles` and `InsightsCard` (lines 14 and 53). Undocumented in CLAUDE.md, so a session reusing the earnings tiles writes `import MonthSummaryCard from '../components/MonthSummaryCard'`, gets `undefined`, and crashes on screen open. That is precisely the failure class __tests__/importIntegrity.test.js was written for, and it is not covered by it (the identifier IS imported, it just resolves to undefined).
- **[medium]** `MoneyGoalCard / GoalsChallengesCard / ReviewCard` — /Users/chrismalson/Documents/gohustle/src/components/MoneyGoalCard.js, GoalsChallengesCard.js, ReviewCard.js
  - These are what ProfileScreen actually composes today. `MoneyGoalCard({ navigation })` takes a required `navigation` prop (money goal, covered by __tests__/goalCard.test.js); `GoalsChallengesCard` exports `XpCard` and `ChallengesList` alongside its default; `ReviewCard({ review })` is shared by ProfileScreen and ReviewsScreen. CLAUDE.md documents the older XPBar/BadgeGrid/ChallengeCard trio instead, so a session editing the Profile hub looks for the wrong components.
- **[medium]** `StudentVerifyModal / StudentBadge` — /Users/chrismalson/Documents/gohustle/src/components/StudentVerifyModal.js, StudentBadge.js
  - CLAUDE.md's ProfileScreen row says 'identity + student verification' but names no component. StudentBadge is rendered inside JobCard.js:118 and PosterTrustCard.js:24 gated on `poster.studentVerified`, and the FilterSheet Trust section filters on `verifiedStudentsOnly`/`campusOnly`. A session adding a poster-trust affordance re-implements a badge that exists and is already mirrored on web (web/components/ui/StudentBadge.tsx).

<details><summary>How a test would enumerate this surface</summary>

Yes — fully mechanisable, and two separate jest tests are warranted. Both are pure fs+regex, ~1s, and both FAIL on the current tree, so they are proven to discriminate. Model them on the existing /Users/chrismalson/Documents/gohustle/__tests__/docIndex.test.js, which already does this for root markdown files.

TEST 1 — presence (catches the 7 in_code_not_in_doc findings above). Suggested path __tests__/componentIndex.test.js:

  const fs = require('fs'), path = require('path');
  const ROOT = path.join(__dirname, '..');
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  fs.readdirSync(path.join(ROOT, 'src/components'))
    .filter(f => f.endsWith('.js'))
    .map(f => f.replace(/\.js$/, ''))
    .forEach(name => it(`${name} is documented`, () => {
      const found = new RegExp('`' + name + '`|<' + name + '\\b').test(claude);
      expect(`${name}: ${found ? 'documented' : 'UNDOCUMENTED — add it to Key Components in CLAUDE.md'}`)
        .toBe(`${name}: documented`);
    }));

  Shell equivalent, verified against the tree:
    for f in src/components/*.js; do n=$(basename "$f" .js); grep -q "\`$n\`\|<$n" CLAUDE.md || echo "MISSING: $n"; done
  Fails today on exactly 12: FloatingTabBar, GoalsChallengesCard, KeyboardDoneBar, Logo, MoneyGoalCard, MonthSummaryCard, ReviewCard, SafetyBar, StudentBadge, StudentVerifyModal, TagInput, WorkStatusBar.

TEST 2 — prop parity (catches the high-severity wrong-signature findings; this is the one that matters). Only enforced on bullets that CLAIM a prop list, i.e. contain the word "Props", so prose-only entries such as JobCard/XPBar are not forced into a props contract:

  function propsOf(src) {                                  // top-level destructured params
    const m = src.match(/export default function\s+\w+\s*\(\s*\{([\s\S]*?)\}\s*\)\s*\{/);
    if (!m) return [];
    const body = m[1].replace(/\/\/[^\n]*/g, '')
                     .replace(/'(?:[^'\\]|\\.)*'/g, "'S'")
                     .replace(/"(?:[^"\\]|\\.)*"/g, '"S"');   // so commas in defaults don't split
    const out = []; let depth = 0, cur = '';
    for (const ch of body) {
      if ('([{'.includes(ch)) depth++;
      if (')]}'.includes(ch)) depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim()).filter(Boolean)
              .map(s => { const i = s.indexOf('='); return { name: (i === -1 ? s : s.slice(0, i)).trim(), required: i === -1 }; });
  }
  const bulletFor = n => (claude.match(new RegExp('^- \\*\\*`' + n + '`\\*\\*[\\s\\S]*?(?=\\n- \\*\\*|\\n#|\\n\\n)', 'm')) || [null])[0];
  // for each component whose bullet matches /Props/:
  //   expect(props.filter(p => !new RegExp('`[^`]*\\b' + p.name + '\\b').test(bullet)).map(p => p.name)).toEqual([]);

  Run today this fails on exactly three, with ZERO false positives:
    Avatar             → textColor
    CompletionModal    → visible (required), onClose (required)
    MessageSheet       → visible (required), jobId (required), onViewProfile (required), onViewJob (required), embedded
  (BookingStatusBadge and ScreenHeader pass, confirming the check is not just noise.)

TEST 3 — optional, one line, catches the ChallengeCard class of stale reference: every component CLAUDE.md backticks must both exist on disk and have ≥1 importer.
    grep -rl "components/ChallengeCard" src/ App.js   # → empty today, while CLAUDE.md says it is "in ProfileScreen"

WHAT CANNOT BE MECHANISED: the semantic claims — "RatingStars is a display/input component" (the signature is legal, the sentence is false), the onConfirm PAYLOAD keys (they appear in a call expression, not the signature; a regex on `onConfirm({...})` inside the component would work but is brittle), and SignedImage's `value` prop (documented only as a JSX snippet with an ellipsis, not a Props list, so Test 2 skips it). Those three need a human or a hand-written assertion per component.

</details>

## Database tables (65 `create table` across supabase/**/*.sql) and the 7 Supabase Storage buckets, vs CLAUDE.md's "Supabase Schema Notes" (L583-589) and "Images (Supabase Storage buckets)" (L165-175)

*Mechanically enumerable: True*

### CLAUDE.md says this, and it is wrong

- **[high]** L52: "**`supabase/migrations/` is the source of truth for the ENTIRE live schema** — every guard, policy, trigger and RPC … Never hand-apply SQL in the dashboard; that is how the two drift."
  - Reality: `supabase/migrations/` creates only 34 of the 65 tables. The core 31 — `profiles`, `jobs`, `bookings`, `messages`, `payments`, `reviews`, `job_slots`, `disputes`, `blocks`, `reports`, `expenses`, `income_entries`, `conversation_state`, `push_tokens`, `stripe_accounts`, `stripe_customers`, `favorites`, `saved_jobs`, `saved_searches`, `notifications`, `referrals`, `legal_documents`, `legal_acceptances`, `assistant_*`, `student_email_verifications`, `class_schedule`, `badges`, `user_challenges`, `job_requirements` — exist only in `supabase/schema.sql` and the legacy `supabase/migration_*.sql` files, which the same bullet says were "applied manually in the Supabase SQL Editor". `supabase db push --linked` against a fresh project produces a database in which almost nothing works. Worse, `jobs.recurrence` is created by NO sql in the repo at all (see next row).
- **[high]** L589: "Jobs have … a `recurrence` column (`none`/`weekly`/`biweekly`/`monthly`)"
  - Reality: No `recurrence` appears anywhere under `supabase/` — not in schema.sql, not in any legacy migration_*.sql, not in any of the 173 files in supabase/migrations/. `grep -rli recurrence supabase` returns nothing. Yet `src/context/JobsContext.js:1091` puts `recurrence` in every `jobs` INSERT, and shared/transforms.js:38, web/lib/types.ts:58 and both JobCards read it. The column therefore exists in production only because it was hand-applied in the dashboard — the exact failure L52 warns against. Consequence: a fresh `db push` yields a schema where posting any gig fails with PGRST204, and no migration in the repo can restore the column.
- **[low]** L165-175: bucket list — "Three are public, four are private", with per-bucket public/PRIVATE flags for avatars, job-photos, completion-photos, chat-photos, receipts, certificates, support-photos.
  - Reality: VERIFIED CORRECT — no drift. All 7 buckets exist and no eighth does; derived flags from SQL are {avatars:true, job-photos:true, certificates:true, completion-photos:false, chat-photos:false, receipts:false, support-photos:false}, matching the doc exactly. One fragility worth recording rather than a defect: `receipts` is the only bucket whose privacy flip lives OUTSIDE supabase/migrations/ (supabase/migration_receipts_private.sql:3), so any check or replay scoped to `supabase/migrations/` alone concludes `receipts` does not exist and mis-derives it. Note also that `avatars`/`job-photos`/`certificates` are "public" only in the render sense — 20260725000000_storage_enumeration_lockdown.sql scopes their SELECT policy to the owner's folder, which the doc does say.
- **[medium]** L52: "166 files as of 2026-08-13, and production's `supabase_migrations.schema_migrations` matches them file-for-file."
  - Reality: `ls supabase/migrations/*.sql | wc -l` = 173. Seven files (the 202608130*/20260812* tail, incl. mfa_recovery_codes, assistant_confirm_gate, payout_tracking follow-ups, support_intake_single_writer) are newer than the count. Since the count is the only thing tying the file set to the production ledger, the "matches file-for-file" assurance is stale on its face, and a session deciding whether a `db push` is outstanding gets the wrong answer.

### Exists, undocumented

- **[high]** `jobs.location is masked server-side; the exact address lives in `job_locations`` — supabase/migrations/20260722040000_mask_job_location_server_side.sql:75 (table); src/screens/JobDetailScreen.js:135, src/screens/EditJobScreen.js:79, web/app/(app)/jobs/[id]/page.tsx:95, web/app/(app)/hiring/[id]/edit/page.tsx:33 (readers)
  - CLAUDE.md's schema notes describe `jobs` and its columns but never say that `trg_mask_job_location` REWRITES `jobs.location` at write time (dropping street lines) and snaps lat/lng to 2 decimals, stashing the typed address in the RLS-gated `job_locations` table. A session trusting the doc reads `jobs.location` for any address/navigation/receipt feature and silently gets "Dallas, TX" instead of "123 Main St, Dallas, TX", or writes a round-trip test on the posted location that fails for reasons the doc cannot explain. Four shipped client files already have to do the second query.
- **[high]** ``gig_shares` + `safety_checkins` — the entire in-person safety subsystem` — supabase/migrations/20260806180000_gig_safety.sql:46,~; supabase/migrations/20260806230000_checkin_false_page.sql; src/components/SafetyBar.js:52,89 (create_gig_share / raise_gig_emergency); src/screens/EarnScreen.js:27,490
  - Share-my-gig links, overdue check-in escalation and the emergency button are live in EarnScreen, carry anon-readable share tokens, deliberately disclose the EXACT address to a third party, and have their own controls. CLAUDE.md names neither table, neither RPC, nor `SafetyBar` in Key Components, and its EarnScreen row lists no safety surface. A session changing booking lifecycle, `bookings.started_at`, `jobs.estimated_hours` or address handling breaks or silently disables a safety escalation it never knew existed.
- **[high]** ``stripe_accounts` and `stripe_customers`` — supabase/migration_stripe.sql (create table public.stripe_accounts / public.stripe_customers); 70 and 8 references across src/, web/, admin/, supabase/functions/
  - CLAUDE.md has ~90 lines on money (Transactions, fee pinning, payouts, step-up) and names `payments`, `stripe_payouts`, `platform_rates`, `fee_tiers`, `bonus_ledger` — but never the two tables that map a Supabase user to their Connect account and their Stripe customer. Every payment/payout/step-up edge function reads them. A session adding a money path looks for the Connect id, does not find it documented, and either re-derives it from Stripe by email or invents a second mapping table.
- **[high]** ``tip_ledger` — the idempotency ledger for tips` — supabase/migrations/20260624211000_tip_ledger.sql; written by supabase/migrations/20260722010000_audit_followups.sql:183,190; asserted by controls in supabase/migrations/20260806040000_control_library.sql:67,270
  - CLAUDE.md's tips line (L41) says tips land in `bookings.tip_amount` and stops there. `tip_ledger` is what makes tip crediting idempotent and is what two `ctl_*` controls reconcile against. A session rebuilding or retrying the tip path against `bookings.tip_amount` alone double-credits an earner and trips a control it was never told about — and money features are exactly where CLAUDE.md demands a pinned amount plus a data-level invariant.
- **[low]** ``category_groups`` — supabase/migrations/20260805000000_dynamic_categories.sql
  - The Categories section says the seed covers "~200 canonical categories across 19 groups" and names the `categories` table and its `status` values, but not that groups are their own table with its own guard (20260805040000_guard_category_group_key.sql). A session adding a group writes a free-text string into `categories.group` and trips the guard.
- **[low]** ``beta_allowlist`, `moderation_flags`, `moderation_rate`, `push_send_rate`, `promo_redeem_attempts` siblings, `admin_login_attempts`, `admin_user_notes`` — supabase/migrations/20260710000000_beta_invite_gate.sql, 20260713010000_moderation_flags.sql, 20260715080000_moderation_rate_limit.sql, 20260707030000_send_push_rate_limit.sql, 20260806090000_admin_roles.sql, 20260705010000_admin_console.sql
  - CLAUDE.md describes the behaviours (beta gate, moderation, push rate limit, "5 failures per account / 15 min, or 20 per IP") without naming the tables that hold the state. Lower stakes individually, but they are the rows a session must clear or seed when testing those paths, and PRE_LAUNCH_DATA_RESET.md's completeness cannot be checked against a table list the doc does not have.
- **[low]** ``class_schedule`, `job_requirements`, `user_challenges`, `badges`` — supabase/migration_hustler_suite.sql (class_schedule); supabase/schema.sql (job_requirements, user_challenges, badges)
  - Legacy/gamification tables never named as tables. `badges`/`user_challenges` matter because UserContext's `unlockBadge`/`updateChallenge` are documented as context exports with no backing store named, so a session refactoring achievements does not know whether state is server-side.
- **[medium]** ``notifications` (in-app inbox) and `notification_preferences` (per-user opt-out gate)` — supabase/migration_notifications_inbox.sql, supabase/migration_competitive_features.sql (notifications); supabase/migrations/20260713000000_notification_preferences.sql
  - The "Push notifications" section (L121-122) names only `push_tokens` and describes `notify()` as the whole story. There is also a persisted in-app inbox and a preferences table the send path is expected to honour (the NotificationSettings route is listed in ProfileStack with no backing table named). A session adding a notification type ships push-only, bypasses the user's opt-out, and leaves the inbox empty for that event.
- **[medium]** ``assistant_threads`, `assistant_messages`, `assistant_rate`` — supabase/migration_hustler_suite.sql (threads, messages); supabase/migration_assistant_rate_limit.sql (rate)
  - The Hustlr AI section names only `assistant_pending_actions`. Conversation persistence and the rate limiter live in three other tables (63 references to assistant_threads across the codebase). A session changing the assistant edge function's history or throttle has no pointer to where either is stored.
- **[medium]** ``saved_jobs`, `saved_searches`, `favorites`` — supabase/migration_competitive_features.sql (saved_jobs, saved_searches); supabase/migration_favorites.sql; notifier trigger in supabase/migrations/20260726140000_saved_search_notifier_cannot_abort_posting.sql
  - CLAUDE.md lists `SavedGigs` and `Favorites` as ProfileStack routes and says "Saved gigs/people" on ProfileScreen, but names no table for any of them. `saved_searches` additionally fires a notifier on job insert that a whole migration exists to stop from aborting posting — a session touching the jobs insert path cannot find that dependency from the doc.
- **[medium]** ``mfa_recovery_codes` and `mfa_recovery_attempts`` — supabase/migrations/20260813010000_mfa_recovery_codes.sql; see also 20260813070000_recovery_codes_require_aal2.sql
  - The Two-factor section explains recovery-code semantics in prose (generated at enrollment, redeeming removes the factor) but names neither the code store nor the attempt-throttle table. A session hardening or debugging the recovery path has to rediscover both, including that attempts are rate-limited separately.
- **[medium]** ``student_email_verifications`` — supabase/migration_student_verification.sql; see also supabase/STUDENT_VERIFICATION.md
  - CLAUDE.md documents Stripe Identity ID-verification in detail (L587) and mentions "student verification" once as a ProfileScreen row, with no table, no columns and no pointer to supabase/STUDENT_VERIFICATION.md. `profiles.school` is pinned once verified by 20260726120000_pin_school_once_verified.sql — a guard a session editing profile writes will hit with no explanation.

<details><summary>How a test would enumerate this surface</summary>

Fully mechanisable. I prototyped all four assertions and they run correctly today. Suggested `__tests__/schemaSurface.test.js`:

```js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const sqlFiles = (d, a = []) => (fs.readdirSync(d, {withFileTypes:true}).forEach(e => {
  const p = path.join(d, e.name);
  e.isDirectory() ? (e.name !== 'node_modules' && sqlFiles(p, a)) : e.name.endsWith('.sql') && a.push(p);
}), a);
const FILES = sqlFiles(path.join(ROOT, 'supabase'));          // MUST be supabase/**, not supabase/migrations/**
const SQL   = FILES.map(f => fs.readFileSync(f, 'utf8')).join('\n;\n');
const MD    = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
```

**1. Buckets — the high-severity one. Derived map must equal the documented map.**
```js
const derived = new Map();
for (const m of SQL.matchAll(/insert\s+into\s+storage\.buckets\s*\([^)]*\)\s*values\s*\(\s*'([a-z0-9-]+)'\s*,\s*'[a-z0-9-]+'\s*,\s*(true|false)/gi))
  derived.set(m[1], m[2].toLowerCase() === 'true');
// only monotonic public->private flips exist today; assert that, so "last write wins" needs no file ordering
expect(SQL.match(/update\s+storage\.buckets\s+set\s+public\s*=\s*true/gi)).toBeNull();
for (const m of SQL.matchAll(/update\s+storage\.buckets\s+set\s+public\s*=\s*false\s+where\s+id\s*=\s*'([a-z0-9-]+)'/gi))
  derived.set(m[1], false);

const sec = MD.split('### Images (Supabase Storage buckets)')[1].split('\nAll writes are owner-scoped')[0];
const doc = new Map([...sec.matchAll(/^- `([a-z0-9-]+)`[^\n]*?\*\*(public|PRIVATE)\*\*/gm)]
  .map(m => [m[1], m[2] === 'public']));

expect(Object.fromEntries([...doc].sort())).toEqual(Object.fromEntries([...derived].sort()));
const nPub = [...derived.values()].filter(Boolean).length;
expect(sec).toMatch(new RegExp(`${['','One','Two','Three','Four','Five','Six','Seven'][nPub]} are public, ${['','one','two','three','four','five','six','seven'][derived.size-nPub]} are private`, 'i'));
```
Current derived value (all matching the doc): `{avatars:true, job-photos:true, certificates:true, completion-photos:false, chat-photos:false, receipts:false, support-photos:false}`. This is the assertion that stops someone rendering a `getPublicUrl` that 400s, or assuming a private bucket when it is not.

**2. Tables — every table is named in CLAUDE.md or explicitly waived.**
```js
const WAIVED = { /* table: 'why the doc need not name it' */
  moderation_rate:'internal rate limiter', push_send_rate:'internal rate limiter',
  admin_login_attempts:'internal throttle', promo_redeem_attempts:'internal throttle',
  mfa_recovery_attempts:'internal throttle', class_schedule:'legacy, unused',
  job_requirements:'legacy, unused', admin_user_notes:'admin-console-local',
};
const tables = new Map();
for (const f of FILES) for (const m of fs.readFileSync(f,'utf8')
    .matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi))
  if (!tables.has(m[1])) tables.set(m[1], path.relative(ROOT, f));
const undocumented = [...tables.keys()].filter(t => !WAIVED[t] && !new RegExp(`\\b${t}\\b`).test(MD));
expect(undocumented).toEqual([]);   // fails today with 26 entries
```
Fails today on: `admin_login_attempts, admin_user_notes, assistant_messages, assistant_rate, assistant_threads, beta_allowlist, category_groups, class_schedule, favorites, gig_shares, job_locations, job_requirements, mfa_recovery_attempts, mfa_recovery_codes, moderation_flags, moderation_rate, notification_preferences, push_send_rate, safety_checkins, saved_jobs, saved_searches, stripe_accounts, stripe_customers, student_email_verifications, tip_ledger, user_challenges`. Seed `WAIVED` with the genuinely-internal ones and document the rest; after that the test fails the moment a migration adds a table nobody wrote down.

**3. Migration count claim.**
```js
const n = fs.readdirSync(path.join(ROOT,'supabase/migrations')).filter(f=>f.endsWith('.sql')).length;
expect(MD).toMatch(new RegExp(`\\b${n} files as of`));   // fails today: doc says 166, actual 173
```

**4. Every column a client writes must be defined by SQL in the repo — this is what catches `recurrence`.**
```js
const ctx = fs.readFileSync(path.join(ROOT,'src/context/JobsContext.js'),'utf8');
const body = ctx.match(/\.from\('jobs'\)\s*\n?\s*\.insert\(\{([\s\S]*?)\n\s*\}\)/)[1];
const keys = [...new Set([...body.matchAll(/(?:^|[,{\s])([a-z][a-z0-9_]*)\s*:/g)].map(m=>m[1]))];
expect(keys.filter(k => !new RegExp(`\\b${k}\\b`).test(SQL))).toEqual([]);  // fails today: ['recurrence']
```
(The `\b100\b` from `Math.round(lat*100)/100` is filtered by the leading `[a-z]` anchor; verified.)

What is NOT mechanisable: whether the doc's *description* of a table is right (e.g. that `jobs.location` is masked, or that `tip_ledger` is the idempotency key). The name-presence test above is the honest proxy — it forces a human decision per new table rather than asserting quality of prose.

</details>

## controls (ctl_* functions + the `controls` registry, `run_all_controls`/`controls_sweep_and_page`, and the `__tests__/adminSurface.test.js` guard CLAUDE.md points at)

*Mechanically enumerable: True*

### CLAUDE.md says this, and it is wrong

- **[high]** CLAUDE.md:257 — "`__tests__/adminSurface.test.js` fails on an unregistered control and on a console page missing from `Nav.tsx`."
  - Reality: It catches only one narrow spelling, and is trivially defeated by shapes this repo already writes. `defined` is `/create or replace function public\.(ctl_[a-z0-9_]+)\s*\(/g` — a control written as `create function public.ctl_x(` (no OR REPLACE), in uppercase DDL, without the `public.` prefix, or with a newline between `function` and the name is INVISIBLE and can never be reported. `registered` is `/'(ctl_[a-z0-9_]+)'\s*\)/g` matched against ALL migrations concatenated — it is not scoped to `insert into public.controls` at all, so ANY occurrence of the literal `'ctl_x')` anywhere counts as registered. The repo already writes exactly that shape: 20260813030000_restore_escrow_expiry_control.sql:74 has `from pg_proc where proname = 'ctl_escrow_hold_expiring_work_done';` inside a self-assertion DO block. Ending that line with `)` instead of `;` — the far more common form — would register the control as far as the test is concerned, with no registry row. PROVEN by simulation: I appended three plausible new controls (an assertion-only one, an uppercase one, and a `create function` one) to the real concatenated SQL; the shipped test reported `unregistered: none` for all three, while the statement-scoped check in `how_to_enumerate` reported all three. The test is green at HEAD (19/19) and the console-page half of it is sound; it is only the control half that is decorative.
- **[low]** CLAUDE.md:52 — "166 files as of 2026-08-13, and production's `supabase_migrations.schema_migrations` matches them file-for-file."
  - Reality: `supabase/migrations/` holds 173 `.sql` files (and 173 entries total — no non-SQL files). Adjacent to this surface rather than part of it, but it is the same failure mode as the 47: a hand-maintained count in prose that nothing asserts. The "matches file-for-file" half cannot be checked from disk and should be re-verified before being trusted.
- **[medium]** CLAUDE.md:373 — "Production monitoring is already continuous and does not need an agent: 47 `controls` run hourly via pg_cron with a daily digest."
  - Reality: The true number is 50 registry rows: 49 `ctl_*` SQL functions plus 1 external row (`stripe_reconciliation`, fn_name `external:reconcile-stripe`, 20260806130000_stripe_reconciliation.sql:114). Of those, 49 execute inside `run_all_controls()` — it filters `where enabled and not external` — and the external one is dispatched separately by `controls_sweep_and_page` as an http_post to `/reconcile-stripe`. All 49 functions ARE registered (zero orphans, verified with a statement-scoped parse), so the board is not actually blind; the doc is just stale. "47" was correct at commit 69b5fb9 (2026-08-13 08:59, the commit that wrote the line: 46 functions + 1 external). Three controls landed later THE SAME DAY — `ctl_promo_spend_understated` (20260813040000), `ctl_dead_listing_open` (20260813060000), `ctl_support_intake_writable` (20260813090000) — and nothing failed. A session reading 47 and counting 49 has to reconcile a phantom discrepancy before it can trust the surface at all.
- **[medium]** CLAUDE.md:504-506 — "`pg_cron`: `controls_sweep_and_page` hourly at `:05` (vesting, then all controls, then pages only if something newly needs a human)"
  - Reality: Correct on schedule and ordering (`cron.schedule('controls_sweep', '5 * * * *', …)` and `('controls_digest', '5 13 * * *', …)` at 20260806030000_schedule_controls.sql:108-109), but the parenthetical describes a three-step body that has been a four-step body since 20260813060000. The live order is vest_bonuses → expire_stale_pending_bookings(14) → expire_dead_listings → run_all_controls → reconcile-stripe dispatch → page dispatch. Also note `reenable_expired_controls()` is called at the top of `run_all_controls()` (20260806350000_controls_always_on.sql:118), not at the top of the sweep as CLAUDE.md:518-520 words it — same net effect today, but a session that rewrites `run_all_controls` from the doc's wording drops the un-mute step.

### Exists, undocumented

- **[high]** `expire_dead_listings() — a fourth step in the hourly sweep CLAUDE.md never mentions` — /Users/chrismalson/Documents/gohustle/supabase/migrations/20260813060000_expire_dead_listings.sql:106-166
  - CLAUDE.md's Controls section lists exactly one extra sweep step: "The hourly sweep also runs `expire_stale_pending_bookings(14)`". The live body of `controls_sweep_and_page` runs FOUR things: vest_bonuses(), expire_stale_pending_bookings(14), expire_dead_listings(), run_all_controls(). `expire_dead_listings` is the only one whose name appears ZERO times in CLAUDE.md (grep confirmed). This matters because the repo's convention is to re-create the whole sweep body every time something is added — six migrations have done `create or replace function public.controls_sweep_and_page` (20260806030000, 20260806080000, 20260806130000, 20260806330000, 20260812090000, 20260813060000), each with a comment saying it was "Reproduced from the LIVE body". A session that reproduces that body from CLAUDE.md's description silently drops the call, and no test, error, or control notices: dead listings just start being browsed and offered again, including back to the person who already worked them. This is the identical failure shape as ctl_escrow_hold_expiring_work_done, which sat blind for a week after 20260806150000 rewrote it and dropped two predicates.
- **[high]** `The ctl_* function contract — return shape, SECURITY DEFINER, and the mandatory revoke` — /Users/chrismalson/Documents/gohustle/supabase/migrations/20260806040000_control_library.sql (pattern repeated by all 49)
  - CLAUDE.md's obligation is one clause: "Write a `ctl_*` function AND register it in `controls`". It never states the contract, yet 49/49 follow it exactly (verified): `returns table (entity_id text, detail jsonb)`, `language sql`/`plpgsql`, `stable`, `security definer`, `set search_path = public`, and immediately after, `revoke execute on function public.<fn>() from public, anon, authenticated`. The return shape is load-bearing — run_control's `execute format(...)` selects `entity_id, detail from public.%I()` (20260806010000_control_framework.sql:139-152), so a different shape errors at sweep time. The revoke is worse because it fails SILENTLY: without it a SECURITY DEFINER function is executable by `authenticated`, and control bodies return other users' `earner_id`, `poster_id`, `amount_cents` and booking internals (e.g. ctl_escrow_hold_expiring_work_done returns earner_id + amount_cents). A new session writing its first control from CLAUDE.md alone has no reason to add the revoke, and nothing in the repo would flag it.
- **[low]** `control_status() — the function behind the "errors or goes stale is reported as loudly as a violation" claim` — /Users/chrismalson/Documents/gohustle/supabase/migrations/20260806010000_control_framework.sql:223-250
  - CLAUDE.md asserts the behaviour but never names the function; `control_status` appears zero times in the doc. It is what the digest and /controls read for `enabled_count`, `errored` and staleness, and it is also the reason `stripe_reconciliation` stays in the registry as `external = true` (20260806130000's header says so explicitly). A session changing the registry shape has no pointer to the one reader that would break.
- **[medium]** `Registry key and fn_name are deliberately different strings` — /Users/chrismalson/Documents/gohustle/supabase/migrations/20260806040000_control_library.sql:620-683
  - Every one of the 50 registry rows is `('<key_without_prefix>', title, severity, domain, why, 'ctl_<key>')` — e.g. key `escrow_hold_lapsed_uncancelled` / fn_name `ctl_escrow_hold_lapsed_uncancelled` — closed with `on conflict (key) do update set title = excluded.title, why = excluded.why, severity = excluded.severity, fn_name = excluded.fn_name`. CLAUDE.md never says the key drops the `ctl_` prefix, never lists the six required columns, and never mentions the on-conflict upsert. A session registering `key = 'ctl_foo'` produces a row that runs fine but whose `control_findings.control_key`, /controls board entry and digest line are keyed inconsistently with the other 50 — and re-running its migration without the on-conflict clause fails the `db push` on a unique violation.

<details><summary>How a test would enumerate this surface</summary>

Fully mechanisable off the filesystem — no DB needed. Everything below runs against `supabase/migrations/*.sql` concatenated, plus `CLAUDE.md`. Verified by running each expression against the repo at HEAD.

--- 0. SHARED SETUP ---
const dir = path.join(ROOT, 'supabase/migrations');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
const sql = files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
const doc = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');

--- 1. DEFINED CONTROLS (replaces the too-narrow regex in adminSurface.test.js) ---
const defined = new Set([...sql.matchAll(
  /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(ctl_[a-z0-9_]+)\s*\(/gi
)].map(m => m[1].toLowerCase()));
// → 49 at HEAD. The shipped regex /create or replace function public\.(ctl_[a-z0-9_]+)\s*\(/g
//   also returns 49 today but misses `create function`, uppercase DDL, a missing
//   `public.` prefix, and a newline between `function` and the name.

--- 2. REGISTERED CONTROLS — must be scoped to a real INSERT statement ---
A plain substring match cannot be used: control `why` text contains both semicolons and
`'ctl_...'`-shaped literals, so `/insert into public\.controls[\s\S]*?;/` truncates
mid-statement (it yields 38 rows instead of 50). Use a quote/comment/dollar-tag aware
statement splitter, then:

const inserts = statements(sql).filter(s => /insert\s+into\s+public\.controls\b/i.test(s));
const registered = new Set(inserts.flatMap(s =>
  [...s.matchAll(/'(ctl_[a-z0-9_]+)'/g)].map(m => m[1])));            // → 49
const externals = inserts.flatMap(s =>
  [...s.matchAll(/'(external:[a-z0-9-]+)'/g)].map(m => m[1]));        // → 1
const registryRows = registered.size + externals.length;              // → 50

statements() = char scan tracking: `''` escape inside strings, `--` line comments,
`/* */` blocks, and `$tag$…$tag$` bodies; split on `;` only when outside all of those.
(~12 lines; validated — returns exactly 49 sql + 1 external on the real tree.)

--- 3. THE THREE ASSERTIONS ---
(a) no orphan control:
    expect([...defined].filter(f => !registered.has(f))).toEqual([]);
    PROVEN TO DISCRIMINATE: appending `create or replace function public.ctl_ghost_assertion()…`
    plus `do $$ … where proname = 'ctl_ghost_assertion') …`, a `CREATE OR REPLACE FUNCTION
    public.ctl_uppercase_ddl()`, and a `create function public.ctl_no_or_replace()` →
    shipped test reports `[]` (all three missed); this check reports all three.

(b) CLAUDE.md's stated count is the real count:
    const stated = Number(/(\d+)\s*`controls`\s*run hourly/.exec(doc)[1]);   // → 47
    expect(stated).toBe(registryRows);                                        // → 50, FAILS today

(c) every step of the LIVE sweep is named in CLAUDE.md (this is the one that would have
    caught the `expire_dead_listings` omission):
    const sweepFile = files.filter(f =>
      /create or replace function public\.controls_sweep_and_page/i
        .test(fs.readFileSync(path.join(dir, f), 'utf8'))).pop();   // → 20260813060000_expire_dead_listings.sql
    const raw  = fs.readFileSync(path.join(dir, sweepFile), 'utf8');
    const s    = raw.indexOf('create or replace function public.controls_sweep_and_page');
    const body = raw.slice(s, raw.indexOf('$function$;', s) + 11);
    const steps = [...new Set([...body.matchAll(/perform\s+public\.([a-z0-9_]+)\s*\(/g)].map(x => x[1]))];
    // → ['vest_bonuses','expire_stale_pending_bookings','expire_dead_listings','run_all_controls']
    expect(steps.filter(n => !doc.includes(n))).toEqual([]);   // → ['expire_dead_listings'], FAILS today

--- 4. THE UNDOCUMENTED CONTRACT (also mechanisable) ---
expect([...defined].filter(fn => !new RegExp(
  `revoke execute on function public\\.${fn}\\(\\)\\s+from public, anon, authenticated`
).test(sql))).toEqual([]);                    // → [] today (49/49 comply)
expect([...defined].filter(fn => !new RegExp(
  `function public\\.${fn}\\(\\)\\s*\\n?\\s*returns table \\(entity_id text, detail jsonb\\)`, 'i'
).test(sql))).toEqual([]);                    // → [] today (49/49 comply)
Both are green now, which is exactly when to lock them in.

--- 5. NOT MECHANISABLE FROM DISK ---
Whether production's `controls` table actually holds these 50 rows, and whether any row is
sitting `enabled = false`, needs `select key, enabled, disabled_until, last_run_at,
last_error from public.controls order by key;` against the live DB. The filesystem can only
prove the migrations would produce them.

</details>
