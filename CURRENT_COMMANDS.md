# CURRENT_COMMANDS.md — Verified commands for GoHustlr

**Verified:** 2026-07-07 at commit `a70c9b5`. Every command below was read from the actual `package.json` / config files (and the baseline ones were executed — see `BASELINE_STATUS.md`). Stale docs are flagged at the bottom.

## Repo layout (4 workspaces, NOT an npm monorepo)
There is no root workspace manager — each app installs/builds independently.

| Dir | App | Package manager root |
|---|---|---|
| `/` (root, `src/`, `App.js`) | **Mobile** — Expo SDK 54 / React Native 0.81.5 | `package.json` |
| `web/` | **Public web** — Next.js 16 (App Router) | `web/package.json` |
| `admin/` | **Admin console** — Next.js 16 (port 3100) | `admin/package.json` |
| `shared/` | `@gohustlr/shared` — pure ESM logic (no scripts) | `shared/package.json` |
| `supabase/` | Backend — Postgres/RLS + **23** Deno edge functions (AUDIT_REPORT.md/CLAUDE.md say 24 — off by one vs. disk) | `supabase/config.toml` (linked project `nfioebqsgmmzhbksxozc`) |

`web` consumes `shared` via `"@gohustlr/shared": "file:../shared"`. Mobile imports the same logic from `src/lib/*` (which re-exposes/duplicates `shared/*`).

---

## Install
| Target | Command | Notes |
|---|---|---|
| Mobile (root) | `npm install --legacy-peer-deps` | **Always use `--legacy-peer-deps`** (React 19 / RN peer ranges). |
| Add an Expo pkg | `npx expo install <pkg>` | Picks the SDK‑54‑correct version instead of `npm install`. |
| Web | `npm --prefix web install` | `web/node_modules` ships present. |
| Admin | `npm --prefix admin install` | ⚠️ `admin/node_modules` is **not** committed — install before any admin check. |
| Shared | — | No deps/scripts; symlinked into `web` on its install. |

## Dev / run
| Target | Command | Notes |
|---|---|---|
| Mobile (LAN) | `npm start` → `expo start` | Phone on same Wi‑Fi; Expo Go must be the SDK 54 build. |
| Mobile (tunnel) | `npx expo start --tunnel` | Cross‑network (ngrok). If it errors `Cannot read properties of undefined (reading 'body')`, kill all node+ngrok first, retry. |
| Mobile (web preview) | `npm run web` → `expo start --web` | Expo‑web preview of the RN app (distinct from the `web/` Next app). |
| Mobile (Android/iOS native) | `npm run android` / `npm run ios` | `expo run:*` — needs native toolchain / dev client. |
| Web | `npm --prefix web run dev` → `next dev` | http://localhost:3000 |
| Admin | `npm --prefix admin run dev` → `next dev --port 3100` | http://localhost:3100 |

## Lint
| Target | Command | Result today |
|---|---|---|
| Web | `npm --prefix web run lint` → `eslint` | 26 problems (19 errors, 7 warnings) — ALL react‑hooks / React‑Compiler rules (set‑state‑in‑effect, deps). Non‑blocking; build+typecheck+tests pass. ⚠️ **Risk:** these touch auth/payment/data‑loading effects — logic‑sensitive, deferred to owner refactor. |
| Admin | `npm --prefix admin run lint` → `eslint` | Clean. |
| Mobile | *(none)* | **No ESLint config at repo root** — mobile has no lint. Gap; add `eslint-config-expo` post‑beta. |

## Typecheck
| Target | Command | Result today |
|---|---|---|
| Web | `npm --prefix web run typecheck` → `tsc --noEmit` | Clean. |
| Admin | `npm --prefix admin run typecheck` → `tsc --noEmit` | Clean. |
| Root/Mobile | `npx tsc --noEmit` | ✅ **Clean now — after a boring fix applied during this prep.** *Previously* the root `tsconfig.json` excluded only `supabase/functions`, so root `tsc` crawled into `web/`+`admin/` `.tsx` without their `@/*` path aliases and failed with TS2307/TS7006 — a config artifact, **not** a real mobile type error (app source is `.js`, so it isn't type-checked). Fixed by adding `"web"`,`"admin"` to the exclude array (`tsconfig.json:6` now `["supabase/functions","web","admin"]`); re-running `npx tsc --noEmit` at root is clean (exit 0). There is intentionally **no** mobile `typecheck` npm script. See `BASELINE_STATUS.md` #4. **[Needs Fable Review]** — mobile is `.js`, so a clean `tsc` is not evidence of mobile type safety. |

## Unit tests
| Command | Notes |
|---|---|
| `npm test` → `jest` | 79 tests / 10 suites. `testEnvironment: node`; `testMatch: __tests__/**/*.test.js`; ignores `node_modules`, `ios`, `android`, `web`. **Pure‑logic only** (contentFilter, geo, finance, taxFormat, filters, availability, school, certified, analytics, moderationSync). |
| Single suite | `npx jest __tests__/finance.test.js` | |

## Integration / e2e tests
**None exist.** No Detox / Maestro / Playwright / Cypress / @testing-library in any `package.json`. See `BETA_QA_PLAN.md` for the recommended Maestro/Detox happy‑path to add before beta (`LAUNCH_PLAN.md` Phase 1 #6).

## Builds
| Target | Command | Notes |
|---|---|---|
| Web | `npm --prefix web run build` → `next build` | Passes. Deploys to Vercel (`web/vercel.json`). |
| Admin | `npm --prefix admin run build` → `next build` | Passes. Separate Vercel project. |
| Mobile | `eas build --platform <ios\|android\|all> --profile <development\|development-device\|preview\|production>` | **EAS cloud build** (Expo account + network). Profiles in `eas.json`. `production` uses `autoIncrement`. `.easignore` trims the upload to mobile‑only. |
| Web/Admin prod start | `npm --prefix web run start` / `npm --prefix admin run start` | `next start` (after build). |

## Backend build / deploy (Supabase — linked project `nfioebqsgmmzhbksxozc`)
| Action | Command | Notes |
|---|---|---|
| Apply DB migrations | `supabase db push --linked` | **Canonical path.** Source of truth = `supabase/migrations/*.sql` (48 timestamped files). |
| Deploy one edge function | `supabase functions deploy <name>` | 23 functions in `supabase/functions/` (each has an `index.ts`; no `_shared` dir). Note: `AUDIT_REPORT.md`/`CLAUDE.md` say "24" — off by one vs. what is on disk. `stripe-webhook`, `stripe-*-return`, `support-*` are configured in `config.toml`. |
| Set function secrets | `supabase secrets set KEY=… ` | Stripe secret/webhook keys live here (never in the repo). |
| Legacy (historical) | Run `schema.sql` then `migration_*.sql` in the Supabase SQL Editor | Pre‑CLI manual path; already applied. New work uses `db push`. |

## Database migration model
- **Current / canonical:** timestamped files in `supabase/migrations/` applied via `supabase db push --linked`.
- **Legacy:** `supabase/schema.sql` (base) + `supabase/migration_*.sql` (feature migrations) applied manually in the SQL Editor. `migration_fix_lifecycle.sql` is idempotent and ships hardened policies.
- Later migrations override earlier ones — read the **combined** state (e.g., `receipts` bucket is public in `migration_expenses.sql` but made **private** by `migration_receipts_private.sql`).

## Seed data
**No seed script.** `src/data/mockData.js` holds static UI constants only (CATEGORIES, BADGE_DEFS, LEVELS, CATEGORY_COLORS) — not database seed data. A closed beta needs real seeded liquidity per `LAUNCH_PLAN.md` Phase 5 #23.

## Other scripts
| Command | Purpose |
|---|---|
| `npm run brand:sync` → `node scripts/sync-brand-assets.js` | Sync brand assets. |
| `python scripts/gen-brand-assets.py` | Generate brand assets. |

---

## Stale / misleading command references (flagged, not silently "fixed")
1. **Function count off by one:** `CLAUDE.md`/`AUDIT_REPORT.md` say **24** edge functions — there are **23** on disk (`supabase/functions/<name>/index.ts`, no `_shared` dir). `DEPLOYMENT.md:102` reference list omits `stripe-connect-status`.
2. `CLAUDE.md` documents mobile + Supabase commands accurately, but predates the **`web/` and `admin/` apps** — treat `FABLE_HANDOFF.md` as the current top‑level map.
3. `CLAUDE.md` references `npm run web` as "Launch in browser at localhost:8081" — that is the **Expo‑web preview of the mobile app**, not the `web/` Next.js site (`next dev` on :3000). Two different web surfaces. **[Needs Fable Review]** — the 8081 port is the Expo default, not pinned in any config.
4. ⚠️ **`.env.example` files referenced but MISSING.** `DEPLOY.md:31` points to `web/.env.example`; `admin/README.md:32` says `cp .env.local.example .env.local`. Neither file exists on disk (`git ls-files | grep env` → none). A new dev following these docs hits a missing‑file error.
5. **README.md migration path stale:** `README.md:49-53` documents only `schema.sql` + `migration_fix_lifecycle.sql`; the real source of truth is the **48** tracked migrations under `supabase/migrations/` applied via `supabase db push --linked`.
6. **README.md `mockData.js` description stale:** `README.md:124-125` says `src/data/mockData.js` holds `CATEGORIES/BADGE_DEFS/LEVELS/CATEGORY_COLORS` directly; it is now a 186‑byte re‑export — `export * from '../../shared/constants.js'` (`src/data/mockData.js:1-3`). Constants live in `shared/constants.js`.
7. **TESTFLIGHT.md CSP status stale:** `TESTFLIGHT.md:14-16,57-58` describe the web CSP as **"report‑only, promote later"**; `web/next.config.ts:46` already ships an **enforcing** `Content-Security-Policy` (not `-Report-Only`).
8. **CLAUDE.md test description understated:** claims tests are only "contentFilter, geo, taxFormat" — there are **10** test files / 79 cases (§ Unit tests).
9. **Global `eas`/`expo` CLIs are NOT on PATH** — docs writing bare `eas build …` / `expo start …` (`TESTFLIGHT.md:19-25`, `DEPLOYMENT.md:94`) require an `npx` prefix on this machine.
10. **`web/README.md` is untouched create‑next‑app boilerplate** — no GoHustlr‑specific run docs beyond port 3000.
- No stale command was auto‑edited in source; this file is the authoritative command list.

---

## Open questions / for Fable to verify

- **[Needs Fable Review]** Web install flag: `web/README.md` (boilerplate) and `DEPLOY.md` do not specify `--legacy-peer-deps` for web; unverified read‑only whether a clean `web/` install succeeds with plain `npm install` (admin explicitly uses the flag).
- **[Needs Fable Review]** `.env.example` templates absent on disk now (item 4) — whether they were intended‑but‑deleted or never committed; original intent unknown (env files are git‑ignored).
- **[Needs Fable Review]** Expo‑web preview port `8081` (item 3) is not pinned in any config — it is the Expo default, not guaranteed.
- **[Needs Fable Review]** CI: `.easignore` references `.github/` but `.github/workflows/` was not inspected — whether lint/typecheck/test/build run in CI is unconfirmed.
- **[Needs Fable Review]** `supabase functions deploy` in practice: no deploy‑all script exists in‑repo (deployment appears manual); exact per‑function invocation used is not scripted.
- **[Needs Fable Review]** Web deploy from repo root: `DEPLOY.md` claims CLI deploys run from repo root for `../shared` inclusion, but there is no root‑level `.vercel/` or root `vercel.json` in the tree — only `web/vercel.json` and `admin/vercel.json`. Live Vercel link state is not reflected by any tracked file.
- **[Needs Fable Review]** Stripe is in **TEST mode** for beta (`STRIPE_DASHBOARD_BASE` defaults to test — `admin/lib/config.ts:19`, baseline notes) — confirm live‑mode cutover plan.
