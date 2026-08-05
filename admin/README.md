# GoHustlr Admin Console

Internal support tool (v1: user support & accounts). **Never expose publicly beyond
`admin.gohustlr.com`; never add data fetching outside the server runtime.**

## Security model (do not weaken)

- Same production Supabase DB; **all** access is server-side with the service-role
  key (`lib/serviceClient.ts`, a `server-only` module). The browser only ever holds
  a normal anon-key session used to prove identity.
- `lib/guard.ts requireAdmin(minRole)` is THE enforcement point: authentic session
  → TOTP MFA (AAL2) → `admin_users` membership → role. Every server page and server
  action calls it. `proxy.ts` is UX only.
- Pages: Dashboard, Users, Bookings, Moderation, Disputes, Payments, Jobs, Support,
  Errors, Access (beta invites), Flags (kill switches), Team, Audit.
- Roles: `admin` = full. **`support` is read-only EXCEPT the ticket queue** — it may
  reply to tickets, set ticket status, and request an AI draft (`support/actions.ts`
  gates those at `requireAdmin('support')` deliberately; triaging support is the whole
  job). It cannot suspend, verify, notify, edit, or delete.
- The edge functions the console calls with the admin's own JWT (`support-reply`,
  `support-ai-draft`, `send-push`) enforce the SAME role tier themselves via
  `supabase/functions/_shared/adminAuth.ts`. They must — a support user's browser
  holds a valid AAL2 token, so a membership-only check there would hand them
  admin-tier capability the moment they bypass the UI.
- Every mutation and sensitive read writes to `admin_audit_log` (append-only —
  UPDATE/DELETE revoked even from service_role). Fail-closed.
- Suspension = GoTrue `banned_until` + `profiles.suspended_at/suspension_reason`.

Backing schema: `supabase/migrations/20260705010000_admin_console.sql`,
`..._020000_admin_audit_fk_fix.sql` (audit rows outlive their actor — no FK to
auth.users), `..._030000_admin_console_hardening.sql` (guard pins suspension
columns; `admin_revoke_sessions()` is the real "force sign-out" primitive since
GoTrue has no admin logout-by-id endpoint on hosted Supabase).

`STRIPE_SECRET_KEY` is only used to release escrow holds during account deletion;
leave it blank in local dev (deletion still works, escrow release is skipped
best-effort) but set it in Vercel Production.

## Local dev

```bash
npm install --legacy-peer-deps
cp .env.local.example .env.local   # fill in the two server-only keys
npm run dev                        # http://localhost:3100
```

## First-time setup

1. Apply the migrations: `supabase db push --linked` (from repo root).
2. Seed the FIRST admin only (Supabase SQL editor; uuid from Authentication → Users):
   ```sql
   insert into public.admin_users (user_id, role, status)
   values ('<your-uuid>', 'admin', 'active');
   ```
3. Sign in at `/login` with that account's normal GoHustlr credentials; you'll be
   forced through TOTP enrollment (scan QR in 1Password/Google Authenticator).
4. **Everyone after the first is added from `/team`, not SQL.** They must already have
   a GoHustlr account. The row starts `pending` and grants nothing; activate it only
   after they have enrolled their authenticator AND you have confirmed the enrollment
   time with them directly.

### Why access starts as `pending`

`/mfa` enrolls a fresh TOTP factor for anyone who presents valid credentials on an
account that has none, and `requireAdmin` only asks whether the JWT says aal2. If a
membership were active from the moment it was created, whoever held that person's
password — the same auth pool the consumer app uses, so reuse and stuffing apply —
could enroll their own authenticator and reach a service-role console that issues
refunds. `pending` makes winning that race worthless. Enforced in all three deciders:
`lib/guard.ts`, `supabase/functions/_shared/adminAuth.ts`, and `send-push`'s inline check.

## Deploying an update

The Vercel project has **Root Directory = `admin/`**, so this works from the repo root
and builds the admin app rather than the Expo app beside it:

```bash
npx vercel@latest --prod --yes
```

Then verify the domain actually moved — a successful build is not the same as a
promoted alias:

```bash
npx vercel@latest inspect https://admin.gohustlr.com
```

The deployment id it reports must match the one the deploy printed.

## Deploy (separate Vercel project)

1. Vercel → New Project → import this repo, **Root Directory = `admin/`**.
2. Env vars (Production): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `NEXT_PUBLIC_USER_APP_URL` (=`https://gohustlr.com`), `SUPABASE_SERVICE_ROLE_KEY`
   (sensitive), `STRIPE_SECRET_KEY` (sensitive).
3. Domain: `admin.gohustlr.com` (CNAME per Vercel instructions).
4. Optional hardening: enable Vercel Deployment Protection for previews, and
   consider Vercel WAF / IP allowlisting later.

## Adding a new admin action — checklist

1. Server action in the relevant `actions.ts`: `requireAdmin('admin')` → act →
   `audit(ctx, 'domain.verb', …)` → `revalidatePath`.
2. Confirm dialog in the client panel; hide the button for `support` (cosmetic —
   the server check is what counts).
3. Never pass the service client (or anything derived from it) to a client component.
