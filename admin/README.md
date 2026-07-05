# GoHustlr Admin Console

Internal support tool (v1: user support & accounts). **Never expose publicly beyond
`admin.gohustlr.com`; never add data fetching outside the server runtime.**

## Security model (do not weaken)

- Same production Supabase DB; **all** access is server-side with the service-role
  key (`lib/serviceClient.ts`, a `server-only` module). The browser only ever holds
  a normal anon-key session used to prove identity.
- `lib/guard.ts requireAdmin(minRole)` is THE enforcement point: authentic session
  → TOTP MFA (AAL2) → `admin_users` membership → role (`admin` full, `support`
  read-only). Every server page and server action calls it. `proxy.ts` is UX only.
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

1. Apply the migration: `supabase db push --linked` (from repo root).
2. Seed the first admin (Supabase SQL editor; uuid from Authentication → Users):
   ```sql
   insert into public.admin_users (user_id, role) values ('<your-uuid>', 'admin');
   ```
3. Sign in at `/login` with that account's normal GoHustlr credentials; you'll be
   forced through TOTP enrollment (scan QR in 1Password/Google Authenticator).
4. Add helpers the same way with `role = 'support'` (read-only) or `'admin'`.

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
