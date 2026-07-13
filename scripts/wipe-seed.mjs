// scripts/wipe-seed.mjs
// Deletes ONLY @seed.gohustlr.test accounts and their cascaded graph. Safe by design.
//
//   CONFIRM_WIPE=WIPE_SEED_DATA SUPABASE_SERVICE_ROLE_KEY=<key> node scripts/wipe-seed.mjs
//
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nfioebqsgmmzhbksxozc.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPECTED_REF = 'nfioebqsgmmzhbksxozc';   // the intended test project
const SEED_DOMAIN  = 'seed.gohustlr.test';

// ── Safety guards ─────────────────────────────────────────────────────────────
if (!SERVICE_KEY) { console.error('Set SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (process.env.CONFIRM_WIPE !== 'WIPE_SEED_DATA') {
  console.error('Refusing to run. Re-run with CONFIRM_WIPE=WIPE_SEED_DATA'); process.exit(1);
}
if (!SUPABASE_URL.includes(EXPECTED_REF)) {
  console.error(`SUPABASE_URL is not the expected project (${EXPECTED_REF}). Aborting.`); process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function seedUsers() {
  const out = [];
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    data.users.forEach(u => {
      if (u.email && u.email.toLowerCase().endsWith(`@${SEED_DOMAIN}`)) out.push(u);
    });
    if (data.users.length < 1000) break;
  }
  return out;
}

async function main() {
  const users = await seedUsers();
  if (users.length === 0) { console.log('No seed users found. Nothing to do.'); return; }

  console.log(`About to delete ${users.length} seed accounts (and their cascaded data):`);
  users.forEach(u => console.log('  -', u.email, u.id));

  let ok = 0;
  for (const u of users) {
    const { error } = await db.auth.admin.deleteUser(u.id); // hard delete => FK cascade
    if (error) { console.error(`  FAILED ${u.email}: ${error.message}`); continue; }
    ok++;
  }

  // Remove the seed allowlist rows (keyed by email, no FK — not covered by cascade).
  const { error: alErr } = await db.from('beta_allowlist').delete()
    .like('email', `%@${SEED_DOMAIN}`);
  if (alErr) console.error('allowlist cleanup:', alErr.message);

  console.log(`Deleted ${ok}/${users.length} seed accounts. Allowlist rows removed.`);
  console.log('NOTE: the open-beta "*" row (if present) is intentionally left untouched.');
}

main().catch(e => { console.error(e); process.exit(1); });
