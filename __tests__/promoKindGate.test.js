const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// A promo code for a campaign nothing can spend.
//
// `promotions.kind` has three values and only TWO have a consumer:
//
//   fee_override    → consume_promo_grant       (`p2.kind = 'fee_override'`)
//   poster_discount → consume_poster_discount   (`p2.kind = 'poster_discount'`)
//   bonus           → NOBODY. accrue_referral_bonus mints into bonus_ledger off the
//                     `referrals` table and never reads a grant.
//
// redeem_promo_code and grant_promotion_to_users were both written without reference to
// kind, so a code on a bonus campaign walked the happy path: seat burned, grant minted
// with a NULL fee_bps, RPC returns TRUE, user told it applied — and nothing ever matched
// that grant. It was permanent, too: the grant is unique per (user, promotion), so every
// later attempt short-circuited through the already-claimed branch and returned TRUE
// again.
//
// Both functions live in migrations and both are re-creatable, which is the same shape as
// the support-guard exemption that two separate rewrites dropped. So this asserts the
// gate on the NEWEST definition of each, rather than trusting the header comment to be
// read — and asserts the console does not offer an operator a control whose only possible
// outcome is a claim nobody can spend.
//
// Discriminates by construction: before 20260906031000 the newest definition of
// redeem_promo_code was 20260806070000 and of grant_promotion_to_users was
// 20260806120000, and neither body contains the string `kind` at all.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'supabase', 'migrations');
const ADMIN = path.join(ROOT, 'admin');

const SPENDABLE = ['fee_override', 'poster_discount'];

function newestDefining(fnName) {
  const hits = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) =>
      new RegExp(`create or replace function public\\.${fnName}\\s*\\(`, 'i').test(
        fs.readFileSync(path.join(DIR, f), 'utf8'),
      ),
    )
    .sort();
  if (!hits.length) return null;
  const file = hits[hits.length - 1];
  const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
  const start = sql.toLowerCase().indexOf(`create or replace function public.${fnName}`);
  // Stop at the terminating `$$;` so a later function in the same file cannot lend this
  // one a gate it does not have.
  const end = sql.indexOf('$$;', start);
  return { file, body: sql.slice(start, end === -1 ? undefined : end) };
}

describe('a promo code can only be issued for a kind something consumes', () => {
  it('both functions are defined somewhere', () => {
    expect(newestDefining('redeem_promo_code')).not.toBeNull();
    expect(newestDefining('grant_promotion_to_users')).not.toBeNull();
  });

  it('the newest redeem_promo_code refuses a kind no consumer matches', () => {
    const { file, body } = newestDefining('redeem_promo_code');
    // A POSITIVE list, not a `<> 'bonus'` exclusion: a fourth kind is inert on the day it
    // is added, exactly as bonus was, and an exclusion list would welcome it silently.
    SPENDABLE.forEach((k) => {
      expect(`${file} names ${k}: ${body.includes(`'${k}'`)}`).toBe(`${file} names ${k}: true`);
    });
    expect(`${file} gates on kind: ${/kind\s+not\s+in\s*\(/i.test(body)}`).toBe(
      `${file} gates on kind: true`,
    );
  });

  it('redeem_promo_code checks the kind BEFORE it burns a code seat', () => {
    // Order is the whole fix. Behind the increment, the seat is still gone; behind the
    // already-claimed branch, someone holding a pre-existing inert grant keeps being told
    // their code applied.
    const { file, body } = newestDefining('redeem_promo_code');
    const gate = body.search(/kind\s+not\s+in\s*\(/i);
    const claimed = body.search(/already claimed/i);
    const burn = body.search(/set redemptions_used = redemptions_used \+ 1/i);
    expect(`${file}: gate ${gate > 0} / before already-claimed ${gate < claimed} / before seat ${gate < burn}`)
      .toBe(`${file}: gate true / before already-claimed true / before seat true`);
  });

  it('the newest grant_promotion_to_users raises rather than minting an inert grant', () => {
    const { file, body } = newestDefining('grant_promotion_to_users');
    SPENDABLE.forEach((k) => {
      expect(`${file} names ${k}: ${body.includes(`'${k}'`)}`).toBe(`${file} names ${k}: true`);
    });
    const gate = body.search(/kind\s+not\s+in\s*\(/i);
    const insert = body.search(/insert into public\.promo_grants/i);
    // Raising, not returning 0: the only caller is the console under requireFreshAdmin,
    // and a silent 0 there reads as "everyone already had it".
    expect(`${file}: gate ${gate > 0} / before the insert ${gate > 0 && gate < insert} / raises ${/raise exception/i.test(body.slice(gate, insert))}`)
      .toBe(`${file}: gate true / before the insert true / raises true`);
  });

  it('the control that reports the artifacts already issued is registered', () => {
    // The gate is not retroactive: codes already printed and grants already held stay
    // exactly as inert. Without a control that is a silent wrong state.
    const all = fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => fs.readFileSync(path.join(DIR, f), 'utf8'))
      .join('\n');
    expect(all).toMatch(/create or replace function public\.ctl_inert_promo_artifact\s*\(/);
    expect(all).toMatch(/'inert_promo_artifact'/);
  });
});

describe('the console does not offer a control that can only fail', () => {
  const read = (p) => fs.readFileSync(path.join(ADMIN, p), 'utf8');

  it('one list of spendable kinds, not a copy per file', () => {
    const lib = read('lib/promoKinds.ts');
    SPENDABLE.forEach((k) => expect(lib).toContain(`"${k}"`));
    expect(lib).toContain('isGrantableKind');
  });

  it('/promotions only offers Mint codes for a campaign a code can reach', () => {
    const page = read('app/(console)/promotions/page.tsx');
    expect(page).toContain('isGrantableKind');
    // The guard has to wrap the control, not sit somewhere else on the page.
    expect(page).toMatch(/isGrantableKind\(p\.kind\)[\s\S]{0,120}<MintCodes/);
  });

  it('minting is refused server-side too, not just hidden', () => {
    // A hidden button is not a check — a stale tab still posts.
    const actions = read('app/(console)/promotions/actions.ts');
    const mint = actions.slice(actions.indexOf('export async function mintCodes'));
    const body = mint.slice(0, mint.indexOf('export async function', 10) === -1 ? undefined : mint.indexOf('export async function', 10));
    expect(body).toContain('isGrantableKind');
    const gate = body.indexOf('isGrantableKind');
    const insert = body.indexOf('.insert(rows)');
    expect(`gate before insert: ${gate > 0 && insert > 0 && gate < insert}`).toBe('gate before insert: true');
  });

  it("/pricing's grant picker lists only campaigns a grant can deliver", () => {
    const page = read('app/(console)/pricing/page.tsx');
    expect(page).toContain('GRANTABLE_PROMO_KINDS');
    expect(page).toMatch(/\.in\("kind", \[\.\.\.GRANTABLE_PROMO_KINDS\]\)/);
  });
});
