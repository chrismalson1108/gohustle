# BASELINE_STATUS.md — Local baseline checks for beta-readiness

**Run date:** 2026-07-07
**Commit:** `a70c9b5` (master, freshly fast-forwarded from origin/master)
**Machine:** local dev (darwin 24.6.0), Node/npm 11.16.0
**Scope of "safe local":** no production infra touched, no destructive commands, no external calls except the npm registry (dependency install for `admin/` + `npm audit`, explicitly approved). Live Supabase/Stripe/Vercel/EAS were **not** contacted.

> Summary: **All build/test/typecheck/lint/audit checks that gate a beta pass or are non-blocking.** The only "fail" is a spurious root‑`tsc` config artifact (fixed as a boring change — see below). No high‑risk secrets. Web+admin dependency audits are clean; the mobile audit hits are build‑time Expo tooling only.

---

## Results

Legend — **Blocks beta?** = would this stop a closed beta from shipping.

### 1. Unit tests (mobile + shared logic)
- **Command:** `npm test`  (Jest, `__tests__/`)
- **Result:** ✅ **PASS** — 79 passed / 79 (10 suites: analytics, availability, certified, contentFilter, filters, finance, geo, moderationSync, school, taxFormat). 1.4s.
- **Error summary:** none.
- **Likely cause:** n/a.
- **Blocks beta?** No.
- **Recommended next action:** Keep green. These cover **pure logic only** (no lifecycle/RLS/payment/e2e). See `BETA_QA_PLAN.md` for the coverage gaps that matter more for a beta.

### 2. Typecheck — web
- **Command:** `npm --prefix web run typecheck`  (`tsc --noEmit`)
- **Result:** ✅ **PASS** — clean.
- **Blocks beta?** No.
- **Recommended next action:** none.

### 3. Typecheck — admin console
- **Command:** `npm --prefix admin run typecheck`  (`tsc --noEmit`)
- **Result:** ✅ **PASS** — clean.
- **Blocks beta?** No.
- **Recommended next action:** none.

### 4. Typecheck — root / mobile
- **Command:** `npx tsc --noEmit` (repo root)
- **Result:** ⚠️ **FAIL — but spurious (config artifact, not a real error).**
- **Error summary:** ~40 errors, all in `web/**` files: `TS2307 Cannot find module '@/lib/*'` and `TS7006` implicit‑any.
- **Likely cause:** The root `tsconfig.json` excludes only `supabase/functions`, so `tsc` at the root crawls into `web/` and `admin/` and typechecks their `.tsx` files **without those apps' own `@/*` path aliases and settings**. The mobile app source is `.js` (Expo/Babel), so there is no genuine mobile type error. Each app is correctly typechecked by its **own** `typecheck` script (checks #2, #3), which pass.
- **Blocks beta?** No.
- **Recommended next action:** **FIXED (boring) — applied + verified:** added `"web"`, `"admin"` to the root `tsconfig.json` `exclude` array (now `exclude: ["supabase/functions", "web", "admin"]` — `tsconfig.json:6`) so root `tsc` no longer double‑checks the sub‑apps with the wrong config. Re‑running `npx tsc --noEmit` at root after the fix is clean. (Mobile remains JS; there is intentionally no mobile `typecheck` script. **[Needs Fable Review]** — because the app source is `.js`, the *type coverage* this command actually exercises on mobile is minimal; a clean result is not evidence of mobile type safety.)

### 5. Lint — web
- **Command:** `npm --prefix web run lint`  (ESLint via `eslint-config-next`)
- **Result:** ⚠️ **26 problems (19 errors, 7 warnings)** — non‑blocking.
- **Error summary:** All `react-hooks/*` (React‑Compiler) rules: `set-state-in-effect`, `immutability`, `exhaustive-deps` across data‑loading effects (notably `web/lib/user.tsx`, `web/lib/notifications.ts`).
- **Likely cause:** Next 16's config promotes React‑Compiler hook rules to errors; the effects predate them. Working code — build, typecheck, and tests all pass.
- **Blocks beta?** No.
- **Recommended next action:** **Left for Fable / owner (NOT fixed today).** These sit on auth/profile/notification data‑loading effects; a correct fix is a deliberate refactor, not a lint‑silence. Fixing them blind risks regressions in logic‑sensitive UI. Matches prior `AUDIT_REPORT.md` finding **Q‑1**.

### 6. Lint — admin console
- **Command:** `npm --prefix admin run lint`
- **Result:** ✅ **PASS** — clean.
- **Blocks beta?** No.

### 7. Lint — mobile
- **Command:** *(none configured)*
- **Result:** ⚠️ **N/A** — there is **no ESLint config at the repo root**; the mobile app has no lint pipeline.
- **Blocks beta?** No (quality gap).
- **Recommended next action:** Post‑beta, add `eslint-config-expo` for the mobile app. Not urgent for a closed beta.

### 8. Build — web (Next.js)
- **Command:** `npm --prefix web run build`  (`next build`)
- **Result:** ✅ **PASS** — success; all routes compiled (static + dynamic), no errors.
- **Blocks beta?** No.

### 9. Build — admin console (Next.js)
- **Command:** `npm --prefix admin run build`
- **Result:** ✅ **PASS** — success; all `(console)` routes + Proxy middleware compiled.
- **Blocks beta?** No.

### 10. Build — mobile (Expo/EAS)
- **Command:** `eas build --platform <ios|android|all> --profile production` (profiles in `eas.json`: development, development‑device, preview, production)
- **Result:** ⏭️ **NOT RUN** — this is an **EAS cloud build** (requires an Expo account + network + native toolchain); out of scope for a local baseline and would contact external infra.
- ⚠️ **Blocks beta?** No for this local baseline, but a **real production EAS build is itself a beta prerequisite** and must be run by the owner (see `LAUNCH_PLAN.md` Phase 4 #19). **[Needs Fable Review]** — whether an EAS build actually succeeds (native toolchain, signing, `expo-notifications` binary) is unverifiable locally and is a genuine go‑live gate, not a rubber stamp.
- **Recommended next action:** Owner runs a `preview`/`production` EAS build and smoke‑tests on a real device. Local proxy signals: `npm test` (pass) + `npm start` bundling.

### 11. Dependency audit — mobile
- **Command:** `npm audit`
- **Result:** ⚠️ **20 vulnerabilities (19 moderate, 1 high)** — non‑blocking.
- **Error summary:** All transitive under `@expo/*` build tooling (`@expo/prebuild-config` → `@expo/config` / `@expo/config-plugins`; the high is `undici`).
- **Likely cause:** Expo SDK 54 dev/build tooling. **Build‑time only — not part of the shipped RN bundle.**
- ⚠️ **Risk:** the "build‑time only" classification is a judgment call — `undici` (the high) is an HTTP client; if any of these packages were reachable at runtime the risk would be real. Treated as accepted only because they live under `@expo/*` prebuild/config tooling, not the RN bundle. Left unpatched for beta.
- **Blocks beta?** No.
- **Recommended next action:** Bump at the next Expo SDK major upgrade and re‑audit (matches prior `AUDIT_REPORT.md` **D‑2**, accepted risk).

### 12. Dependency audit — web
- **Command:** `npm --prefix web audit`
- **Result:** ✅ **PASS** — **0 vulnerabilities** (the `postcss >=8.5.10` override holds).
- **Blocks beta?** No.

### 13. Dependency audit — admin console
- **Command:** `npm --prefix admin audit`  (after `npm --prefix admin install`)
- **Result:** ✅ **PASS** — **0 vulnerabilities**.
- **Blocks beta?** No.

### 14. Secret scan (local, tracked files)
- **Command:** `git grep -nIE '(sk_live_|sk_test_|rk_live_|rk_test_|whsec_|sb_secret_|AKIA…|-----BEGIN … PRIVATE KEY-----)'` + JWT‑literal probe
- **Result:** ✅ **PASS** — no high‑risk secret material in tracked files.
- **Error summary:** Only 19 references to `sb_publishable_*` / `pk_test_*` / `NEXT_PUBLIC_SUPABASE_*` — **client‑safe by design** (publishable/anon keys). Service‑role key + Stripe secret key are read only server‑side (`admin/lib/serviceClient.ts` is `server-only`) or from edge‑function env; never `NEXT_PUBLIC_`‑prefixed. `.gitignore` excludes `.env*` and native signing artifacts; no `.env` tracked or on disk.
- **Blocks beta?** No.
- ⚠️ **Risk / next action:** Stripe is in **TEST mode** for the beta (verified: `admin/lib/config.ts:19` `STRIPE_DASHBOARD_BASE` defaults to `https://dashboard.stripe.com/test`). Rotate to **live** Stripe keys/secrets at go‑live and set `NEXT_PUBLIC_STRIPE_DASHBOARD_BASE=https://dashboard.stripe.com` in Vercel. **[Needs Fable Review]** — whether the *edge‑function* secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) are test‑ or live‑mode is set out‑of‑band in Supabase function env, not in tracked files, so it cannot be verified from source. Consider a CI secret‑scan (gitleaks) as a standing gate.

---

## Prerequisites / environment notes
- At the time these checks ran, `admin/` had no `node_modules`; it was installed (296 pkgs, 0 vulns) to run its checks. **Note:** a later commands‑dossier pass found `admin/node_modules` (296 entries, `next` binary present) and `web/node_modules` (295 entries) both **present** on disk — i.e. after this install step, admin is installed. `shared/node_modules` is correctly **absent** (`shared/package.json` declares no dependencies — nothing to install); `shared/` is consumed by `web` via `file:../shared` (resolved as a symlink at `web/node_modules/@gohustlr/shared`).
- ⚠️ **Risk (no e2e):** No integration/e2e harness exists (no Detox / Maestro / Playwright / Cypress / @testing-library in any `package.json`; verified in commands‑dossier §6). The 79 Jest tests cover **pure logic only** — no booking‑lifecycle, RLS, payment, or end‑to‑end path is exercised by any automated test. This is the single biggest **automated‑coverage** gap for a beta — see `KNOWN_RISKS.md` and `BETA_QA_PLAN.md`.
- No database seed script; `src/data/mockData.js` holds static UI constants only.
- Builds ran without a local `.env`; Next inlined the committed publishable fallbacks (`web/lib/config.ts`, `admin/lib/config.ts`). For a representative beta build, set real `NEXT_PUBLIC_*` env in Vercel. **[Needs Fable Review]** — the actual Vercel env/project config (what `NEXT_PUBLIC_*` values production serves, and whether the two apps are linked to Vercel projects) is live‑infra state not verifiable from the tracked tree (no root `.vercel/`; only `web/vercel.json` + `admin/vercel.json`).

## What passed / failed at a glance
- **PASS:** mobile tests, web typecheck, admin typecheck, admin lint, web build, admin build, web audit, admin audit, secret scan.
- **Non‑blocking issues:** web lint (26 React‑Compiler findings — owner refactor), mobile dep audit (build‑time Expo tooling), no mobile lint, no e2e.
- **Fixed (boring):** root `tsc` config artifact (excluded `web`/`admin`) — applied + re‑verified clean.
- **Not run (needs owner/infra):** mobile EAS production build.

---

## Open questions / for Fable to verify

These are items asserted or implied above that **cannot be verified from source** in a read‑only local pass (live infra, out‑of‑band env, dashboard state):

1. **[Needs Fable Review]** Mobile `npx tsc --noEmit` cleanliness is near‑meaningless as a type‑safety signal — the app source is `.js`, so a clean run does not evidence mobile type correctness (§4).
2. **[Needs Fable Review]** Edge‑function Stripe secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) are set in Supabase function env, not tracked files — whether they are test‑ or live‑mode is unverifiable here. The *client‑visible* Stripe dashboard base is confirmed test mode (`admin/lib/config.ts:19`) (§14).
3. **[Needs Fable Review]** Vercel env/project config — the actual production `NEXT_PUBLIC_*` values served and whether `web`/`admin` are linked to Vercel projects are live‑infra state; no root `.vercel/` or root `vercel.json` in the tree (Prereqs).
4. **[Needs Fable Review]** A production **EAS build** actually succeeding (native toolchain, signing, `expo-notifications` binary) is unverifiable locally and is a go‑live gate (§10).
5. **CI status unconfirmed** — this pass did not inspect `.github/workflows/` for whether lint/typecheck/test/build run in CI. Worth confirming for the audit.
6. **Web install flag** — unverified whether a clean `web/` install needs `--legacy-peer-deps` (admin explicitly does; web docs don't say). Not testable read‑only.
