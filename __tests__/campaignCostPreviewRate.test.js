const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// The cost preview an operator sizes a campaign from must price at the RATE CARD.
//
// The take rate is data — platform_rates, read through fee_bps_at() — and 1000 bps is
// only the FOUNDING rate kept as a degraded-path fallback. The standing rate has been
// 700 since 2026-08-12, so any benefit costed against a literal 1000 overstates its own
// burn by roughly half at today's posture, and understates it the moment the card moves
// the other way.
//
// This exact literal has now been found in three places, one at a time:
//   · promo_benefit_cents  — 20260806220000 ("THE BUDGET COUNTERFACTUAL HARDCODED
//     1000 bps … a 50% undercount, in the unsafe direction")
//   · capped_override_bps  — 20260814120000, which gave it a baseline argument
//   · estimate_campaign_cost — 20260906075000, the preview, missed by both because it
//     is not on the charge path and therefore never showed up in a money reconciliation
//
// So the assertion is over ALL THREE rather than the one just fixed, and it is written
// against the NEWEST definition of each — every one of these is `create or replace`-able,
// and the support-guard exemption proves a body can lose a property twice.
//
// What it looks for is narrow on purpose: a bare integer handed to platform_fee_cents or
// poster_discount_headroom as the RATE. `coalesce(p_fee_bps, 1000)` inside
// platform_fee_cents itself is the documented fallback and is not in scope here.
//
// Discriminates by construction: before 20260906075000 the newest definition of
// estimate_campaign_cost was 20260806170000, whose body contains
// `platform_fee_cents(p_typical_gig_cents, 1000)` twice and
// `poster_discount_headroom(p_typical_gig_cents, 1000)` twice, and never mentions
// fee_bps_at. Point DIR at that file alone and every case below fails.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'supabase', 'migrations');
const ACTIONS = path.join(ROOT, 'admin', 'app', '(console)', 'promotions', 'actions.ts');

// Functions whose job is to price a benefit against "the rate this would otherwise pay".
const COSTING_FNS = ['estimate_campaign_cost', 'promo_benefit_cents', 'capped_override_bps'];

// A rate argument that is a literal rather than a read of the card.
const LITERAL_RATE = [
  /platform_fee_cents\s*\(\s*[^(),]+,\s*\d+\s*\)/i,
  /poster_discount_headroom\s*\(\s*[^(),]+,\s*\d+\s*\)/i,
];

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
  // Stop at the terminating `$$;` so a later function in the same file — or the probe
  // block at the foot of it, which deliberately calls the old arithmetic — cannot lend
  // this body a property it does not have.
  const end = sql.indexOf('$$;', start);
  return { file, body: sql.slice(start, end === -1 ? undefined : end) };
}

describe('campaign cost is priced from the rate card, never a literal', () => {
  it('every costing function is defined somewhere', () => {
    COSTING_FNS.forEach((fn) => expect(`${fn}: ${newestDefining(fn) !== null}`).toBe(`${fn}: true`));
  });

  COSTING_FNS.forEach((fn) => {
    it(`the newest ${fn} hands no hardcoded rate to a fee function`, () => {
      const { file, body } = newestDefining(fn);
      LITERAL_RATE.forEach((re) => {
        const hit = body.match(re);
        // Name the offending call — "expected false to be true" would send the next
        // reader looking through 200 lines of SQL for it.
        expect(`${file}/${fn}: ${hit ? hit[0] : 'none'}`).toBe(`${file}/${fn}: none`);
      });
    });

    it(`the newest ${fn} resolves its baseline through fee_bps_at`, () => {
      const { file, body } = newestDefining(fn);
      // Either it reads the card itself, or it is handed an already-resolved baseline
      // (capped_override_bps takes one, and falls back to the reader). `p_fee_bps` does
      // NOT count: that is the campaign's own override rate, and accepting it here is
      // what let the old preview — which names p_fee_bps and nothing else — pass.
      const resolves = /fee_bps_at\s*\(/i.test(body) || /p_baseline_bps/i.test(body);
      expect(`${file}/${fn} resolves a real baseline: ${resolves}`).toBe(
        `${file}/${fn} resolves a real baseline: true`,
      );
    });
  });

  it('the preview names the rate it priced at, and admits the tier can lower it', () => {
    const { file, body } = newestDefining('estimate_campaign_cost');
    // The console renders this string verbatim under the figures. A fee_override estimate
    // is an UPPER BOUND — since 20260814120000 the charge is measured against the
    // booking's pinned baseline, which least()s in the earner's loyalty tier and which a
    // per-campaign preview has no earner to resolve.
    expect(`${file} interpolates the rate: ${/fee_bps_at[\s\S]{0,80}to_char|to_char[\s\S]{0,80}fee_bps_at/i.test(body)}`)
      .toBe(`${file} interpolates the rate: true`);
    expect(`${file} says upper bound: ${/upper bound/i.test(body)}`).toBe(
      `${file} says upper bound: true`,
    );
  });

  it('the console asks the database rather than doing the arithmetic again', () => {
    const src = fs.readFileSync(ACTIONS, 'utf8');
    // A preview that re-implements the fee in TypeScript is a fourth copy of the literal
    // waiting to happen, and it is the copy no migration probe can reach.
    expect(src.includes('rpc("estimate_campaign_cost"')).toBe(true);
  });
});
