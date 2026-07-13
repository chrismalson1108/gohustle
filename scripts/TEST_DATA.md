# Test data — seed & teardown

Two scripts for the current (test) Supabase project `nfioebqsgmmzhbksxozc`. Both run as
**service_role** (Dashboard → Project Settings → API → `service_role` secret). Never commit the key.

```bash
# Seed realistic Dallas liquidity (posters + earners + gigs + bookings)
SUPABASE_SERVICE_ROLE_KEY='eyJ...service_role...' node scripts/seed-dallas.mjs

# Wipe ONLY the seed accounts (and their cascaded data) before public beta
CONFIRM_WIPE=WIPE_SEED_DATA SUPABASE_SERVICE_ROLE_KEY='eyJ...' node scripts/wipe-seed.mjs
```

`@supabase/supabase-js` is already a dependency, so no install is needed. Re-running the seed is
safe (existing seed users are reused by email). Sign in as any seed account with `SeedPass!2026`.

## Strategy: how to get rid of test data before public beta

**Recommended: tag-and-purge in place** (not a full DB wipe, not a new project).
Every seed row is tagged by a reserved email domain `@seed.gohustlr.test`. `migration_account_deletion.sql`
already made the FKs cascade, so `auth.admin.deleteUser(id)` erases the whole graph
(profile → jobs → slots/requirements/bookings → messages/reviews/payments/…). `wipe-seed.mjs`
enumerates only seed-domain accounts, deletes them, and removes their allowlist rows.

- **Don't** truncate the DB — you'd destroy `legal_documents` (onboarding gates on it), the
  `beta_allowlist` infra, and any real early testers.
- **A separate prod project** is theoretically cleanest but expensive here (re-run every migration,
  re-seed legal docs, reconfigure Stripe/Identity webhooks + storage + edge secrets, repoint the app).
  Since beta launches on *this* project, that migration is more risk than it removes.

### Verify clean after teardown
- `select count(*) from auth.users where email like '%@seed.gohustlr.test';` → **0**
- `select count(*) from public.jobs where poster_id not in (select id from public.profiles);` → **0**
- Confirm preserved: `legal_documents` unchanged, real testers present, `'*'` allowlist row still there
  if you want open beta to stay open.
- Storage is **not** cascaded — the seed uploads no images, so buckets stay clean. If you add images
  later, delete `<seed-user-id>/…` paths from the buckets during teardown.

## Gotchas (schema-specific)

1. **Beta allowlist gate** — `handle_new_user` rejects any signup whose email isn't allowlisted
   (or unless a `'*'` row exists). The seed upserts each email into `beta_allowlist` first; the wipe
   removes them but **leaves the `'*'` open-beta row alone**.
2. **18+ age floor** — `guard_min_age` blocks a *known* minor on jobs/bookings/messages. The seed sets
   an adult `date_of_birth` (service_role bypasses the trigger, but this keeps the data realistic).
3. **Server-side moderation** — `guard_prohibited_content` scans free text. Keep all seed text clean.
4. **Stripe** — the seed creates **no** Stripe objects and no `payments` rows. Seeded `confirmed`
   bookings have no real escrow behind them — never run capture/tip/refund against them.
5. **Profiles are auto-created** — `handle_new_user` inserts the profile; the seed **UPDATEs** it
   (a second insert would hit the PK).
6. **service_role only** — both scripts need the service_role secret (bypasses RLS + guard triggers +
   the profile column lockdown). Env var only, never committed, never shipped to the client.
7. **`reports` fires a real safety alert** (AFTER INSERT → `safety-alert` edge fn) — don't seed reports.
