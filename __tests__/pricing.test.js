// Drift guard between shared/pricing.js (what the apps DISPLAY) and
// public.platform_fee_cents (what the server actually CHARGES).
//
// Same job as categories.test.js does for category_slug: the two implementations must
// agree, and the only way to be sure is to read the SQL off disk rather than trust a
// comment saying they match. A fee the app quotes and a fee the server takes that
// differ by a cent is a disclosure failure — the Terms commit to the amount being
// "disclosed before you confirm".
//
// ⚠️ THE MIGRATION IS RESOLVED, NEVER NAMED — and the mirror is BUILT FROM IT.
//
// Until 2026-09-06 this file did neither. It opened 20260806050000_platform_rate.sql by
// hardcoded path, and that file's platform_fee_cents body had already been replaced by
// 20260806140000_fee_overflow_fix.sql — so every constant assertion here was pinning
// text Postgres no longer runs. It stayed green only because the replacement happened
// to keep the same constants. The second half was worse: sqlFee() below RETYPED
// 5000 / 0.029 / 30 / 25 as JavaScript literals, so even pointed at the right file it
// mirrored what someone once believed rather than what is on disk. A third
// `create or replace` raising the 25c margin, or "simplifying" the half-up rounding
// back to truncation — the exact bug this was written for — would have shipped with the
// whole suite green, while JobDetail/CompletionModal quoted one fee and
// stripe-capture-payment took another.
//
// Postgres keeps whichever definition ran LAST. So does this, the way
// supportGuardDrift.test.js and tipCaps.test.js already do it. And every constant the
// mirror uses is PARSED out of that body, so moving one moves the mirror and the parity
// matrix disagrees with shared/pricing.js on the next run.
//
// This test cannot execute Postgres, so it does two things instead:
//   1. asserts the CONSTANTS in the live SQL body are the ones the JS uses
//   2. re-implements the SQL's arithmetic from those PARSED constants, and compares it
//      to the JS across a wide range including every rounding edge
// A test that compared two JS constants to each other could never fail; parsing the
// live migration is what gives it teeth.
const fs = require('fs');
const path = require('path');
const { platformFeeCents, earnerNetCents, feeLabel, DEFAULT_FEE_BPS, feeBreakdown
} = require('../shared/pricing.js');

const MIG_DIR = path.join(__dirname, '..', 'supabase', 'migrations');

// Quote-aware comment stripper, lifted from tipCaps.test.js. Necessary here, not merely
// tidy: 20260806140000's own header QUOTES both the broken expression and the fixed one,
// so a regex run over raw text can be satisfied by the prose explaining the code rather
// than by the code.
function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  const tags = [];
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    const dollar = ch === '$' ? sql.slice(i).match(/^\$[a-zA-Z_]*\$/) : null;
    if (dollar) {
      const tag = dollar[0];
      if (tags[tags.length - 1] === tag) tags.pop();
      else tags.push(tag);
      out += tag;
      i += tag.length;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const migrationFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();

// The last migration that defines a function is the one the database is running.
function latestDefining(fnName) {
  const hits = migrationFiles.filter((f) =>
    new RegExp(`create or replace function public\\.${fnName}\\b`, 'i')
      .test(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')));
  const last = hits[hits.length - 1];
  return last
    ? { file: last, sql: stripSqlComments(fs.readFileSync(path.join(MIG_DIR, last), 'utf8')) }
    : null;
}

// Signature + body of one function, stopping at its dollar-quote terminator, so an
// assertion cannot be satisfied by a neighbouring definition in the same file.
function bodyOf(sql, name) {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\b`, 'i'));
  if (start === -1) return '';
  const tagM = sql.slice(start).match(/\bas\s+(\$[a-zA-Z_]*\$)/);
  if (!tagM) return '';
  const bodyStart = start + tagM.index + tagM[0].length;
  const end = sql.indexOf(tagM[1], bodyStart);
  return sql.slice(start, end === -1 ? undefined : end);
}

const feeSrc = latestDefining('platform_fee_cents');
const feeBody = feeSrc ? bodyOf(feeSrc.sql, 'platform_fee_cents') : '';
const rateSrc = latestDefining('fee_bps_at');
const rateBody = rateSrc ? bodyOf(rateSrc.sql, 'fee_bps_at') : '';
// The founding rate is seeded once, by the FIRST migration that writes the rate card;
// later ones append new rates and must not be mistaken for it.
const seedFile = migrationFiles.find((f) =>
  /insert into public\.platform_rates/i.test(fs.readFileSync(path.join(MIG_DIR, f), 'utf8')));

// ── The constants, parsed out of the live body ───────────────────────────────
// Nothing here is retyped. If a future migration moves one of these numbers the mirror
// moves with it and the parity matrix fails against shared/pricing.js — which is the
// entire point, and is what the retyped literals could never do.
const parsed = (() => {
  const round = feeBody.match(/\+\s*(\d+)\s*\)\s*\/\s*(\d+)/);
  const pct = feeBody.match(/ceil\([\s\S]*?\*\s*([0-9]*\.?[0-9]+)\s*\)/);
  const fixed = feeBody.match(/::integer\s*\+\s*(\d+)\s*\+\s*(\d+)/);
  const defBps = feeBody.match(/coalesce\(\s*p_fee_bps\s*,\s*(\d+)\s*\)/);
  return {
    roundOffset: round && Number(round[1]),
    divisor: round && Number(round[2]),
    stripePct: pct && Number(pct[1]),
    stripeFixedCents: fixed && Number(fixed[1]),
    marginCents: fixed && Number(fixed[2]),
    defaultBps: defBps && Number(defBps[1]),
  };
})();

describe('platform_fee_cents SQL/JS parity', () => {
  test('the guard resolved a live definition, and it is not the superseded one', () => {
    // The self-check on the resolver. 20260806050000's body was replaced by
    // 20260806140000; if this file is ever pointed back at a stale definition — or the
    // resolver silently degrades to "the first hit" — this is what says so.
    expect(feeSrc).not.toBeNull();
    expect(feeSrc.file).not.toBe('20260806050000_platform_rate.sql');
    expect(feeBody).toMatch(/create or replace function public\.platform_fee_cents/);
    expect(rateSrc).not.toBeNull();
    expect(seedFile).toBeTruthy();
  });

  test('every constant the mirror uses was actually parsed out of the SQL', () => {
    // A regex that stops matching must FAIL here, not quietly yield null and let the
    // matrix below compare a JS number to a JS number.
    expect(parsed).toEqual({
      roundOffset: expect.any(Number),
      divisor: expect.any(Number),
      stripePct: expect.any(Number),
      stripeFixedCents: expect.any(Number),
      marginCents: expect.any(Number),
      defaultBps: expect.any(Number),
    });
  });

  test('the percentage multiply is widened to bigint — int4 overflows above ~21.47%', () => {
    // THIS ASSERTION EXISTS BECAUSE THE MATRIX BELOW CANNOT CATCH IT.
    //
    // (amount * bps) is int4 * int4 in Postgres and raises 22003 whenever the product
    // exceeds 2^31-1 — at 3000 bps (which platform_rates.fee_bps explicitly permits and
    // the /pricing page lets an admin set) that is every booking over ~$7,158, well
    // inside the $10,000 pay ceiling. Reproduced live before the fix:
    //   platform_fee_cents(1000000, 2147) -> 214700
    //   platform_fee_cents(1000000, 2148) -> ERROR 22003
    //
    // sqlFee() below is JavaScript, which has no 32-bit overflow, so the parity matrix
    // passes on amount=1000000/bps=3000 — the exact pair that raised in Postgres. A
    // behavioural mirror cannot detect an arithmetic-WIDTH defect; only reading the cast
    // out of the migration can. Fixed in 20260806140000 — and asserted here against
    // whatever the LIVE body is, so a later redefinition that drops the cast
    // reintroduces the outage and fails. Pinning 20260806140000 by name, which is what
    // this test used to do, could never catch that.
    expect(feeBody).toMatch(/coalesce\(\s*p_amount_cents\s*,\s*0\s*\)::bigint\s*\*/);
  });

  test('SQL rounds half up — not truncating division', () => {
    // If someone "simplifies" this back to (amount * bps) / 10000 the offset regex stops
    // matching, the constant is null, and the parse test above fires. This pins the
    // RELATIONSHIP: the offset must be exactly half the divisor, and the divisor must be
    // the basis-point scale.
    expect(parsed.divisor).toBe(10000);
    expect(parsed.roundOffset * 2).toBe(parsed.divisor);
  });

  test('SQL floor constants match the JS constants', () => {
    // Stripe's percentage, Stripe's fixed 30c and the 25c platform margin — read out of
    // the live body and checked against what shared/pricing.js actually charges at
    // 0 bps, where the fee IS the floor.
    const amt = 100000;
    expect(platformFeeCents(amt, 0)).toBe(
      Math.ceil(amt * parsed.stripePct) + parsed.stripeFixedCents + parsed.marginCents,
    );
  });

  test('rate is clamped to [500, 3000] and defaults to 1000 in fee_bps_at', () => {
    expect(rateBody).toMatch(/greatest\(500,\s*least\(3000,/);
    expect(rateBody).toMatch(/1000\)\)\)/);
  });

  test('DEFAULT_FEE_BPS matches the SQL fallback and the seeded founding rate', () => {
    expect(DEFAULT_FEE_BPS).toBe(1000);
    // coalesce(p_fee_bps, N) in the live body IS the server's fallback rate; the JS one
    // must be the same number or a degraded path quotes a rate nobody charges.
    expect(parsed.defaultBps).toBe(DEFAULT_FEE_BPS);
    const seed = fs.readFileSync(path.join(MIG_DIR, seedFile), 'utf8');
    expect(seed).toMatch(
      new RegExp(`insert into public\\.platform_rates[\\s\\S]*?select ${DEFAULT_FEE_BPS},`),
    );
  });

  // A literal transcription of the SQL body, built from the constants parsed above —
  // never from numbers retyped here.
  const sqlFee = (amount, bps) => {
    const amt = Math.max(0, Math.trunc(amount));
    const pct = Math.trunc((amt * bps + parsed.roundOffset) / parsed.divisor);
    const floor = Math.ceil(amt * parsed.stripePct)
      + parsed.stripeFixedCents + parsed.marginCents;
    return Math.max(0, Math.min(amt, Math.max(pct, floor)));
  };

  test('agrees with the SQL across amounts and rates, including rounding edges', () => {
    const amounts = [
      0, 1, 50, 99, 100, 999, 1000, 1004, 1005, 1006, 1050, 1499, 1500,
      2500, 4999, 5000, 9999, 10000, 10001, 12345, 99999, 100000, 1000000,
    ];
    const rates = [0, 250, 500, 750, 1000, 1250, 1500, 2000, 3000];
    const mismatches = [];
    for (const a of amounts) {
      for (const r of rates) {
        const js = platformFeeCents(a, r);
        const pg = sqlFee(a, r);
        if (js !== pg) mismatches.push(`amount=${a} bps=${r}: js=${js} sql=${pg}`);
      }
    }
    // Name the file the mirror was built from, so a failure says WHICH migration moved.
    expect(`${feeSrc.file}: ${mismatches.join(' | ')}`).toBe(`${feeSrc.file}: `);
  });

  test('half-up rounding specifically — the bug this was written for', () => {
    // $10.05 at 10% is exactly 100.5c. Truncation gives 100; every shipped client
    // says 101 because they use Math.round.
    expect(platformFeeCents(1005, 1000)).toBe(101);
    expect(platformFeeCents(1004, 1000)).toBe(100);
    expect(platformFeeCents(1015, 1000)).toBe(102);
  });

  test('a 0% promotion still covers processing cost — never a loss', () => {
    for (const amt of [1000, 2500, 5000, 20000]) {
      const fee = platformFeeCents(amt, 0);
      expect(fee).toBeGreaterThanOrEqual(Math.ceil(amt * 0.029) + 30);
      expect(fee).toBeLessThan(amt);
    }
  });

  test('fee never exceeds the amount, so the earner can never go negative', () => {
    for (const amt of [0, 1, 25, 50, 99, 100]) {
      expect(platformFeeCents(amt, 3000)).toBeLessThanOrEqual(amt);
      expect(earnerNetCents(amt, 3000)).toBeGreaterThanOrEqual(0);
    }
  });

  test('garbage in does not produce a zero fee', () => {
    // Fail closed: a null/NaN rate must fall back to the default, not to free.
    expect(platformFeeCents(10000, null)).toBe(1000);
    expect(platformFeeCents(10000, undefined)).toBe(1000);
    expect(platformFeeCents(10000, NaN)).toBe(1000);
  });

  test('earnerNet + fee reconstructs the amount exactly', () => {
    for (const amt of [1000, 1005, 12345, 800000]) {
      for (const r of [0, 500, 1000, 1500]) {
        expect(earnerNetCents(amt, r) + platformFeeCents(amt, r)).toBe(amt);
      }
    }
  });

  test('feeLabel renders rates without trailing noise', () => {
    expect(feeLabel(1000)).toBe('10%');
    expect(feeLabel(500)).toBe('5%');
    expect(feeLabel(0)).toBe('0%');
    expect(feeLabel(1250)).toBe('12.5%');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The promo budget counterfactual, pinned textually.
//
// consume_promo_grant measures "what this discount costs" as (what they would have
// paid) − (what they will pay). The first term was a hardcoded 1000 bps while the
// standing rate is configurable via fee_bps_at — so raising the platform rate to 15%
// made every 0%-fee promo cost 15% while charging the budget 10%. A 50% undercount,
// in the unsafe direction, silently.
//
// This cannot be caught by exercising the JS mirror: the defect is which SQL function
// supplies one operand. So assert on the migration text, the same way the bigint
// overflow cast is pinned above.
// ─────────────────────────────────────────────────────────────────────────────
describe('promo budget counterfactual', () => {
  const lifecycle = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20260806220000_benefit_lifecycle.sql'),
    'utf8',
  );

  test('promo_benefit_cents measures against the standing rate, not a literal', () => {
    const fn = lifecycle.match(
      /create or replace function public\.promo_benefit_cents[\s\S]*?\$\$;/,
    );
    expect(fn).not.toBeNull();
    expect(fn[0]).toMatch(/fee_bps_at\(/);
    // The literal that was the bug. Any bare 1000 as a bps operand is a regression.
    expect(fn[0]).not.toMatch(/platform_fee_cents\(\s*p_amount_cents\s*,\s*1000\s*\)/);
  });

  test('consume_promo_grant uses the helper rather than recomputing the counterfactual', () => {
    const fn = lifecycle.match(
      /create or replace function public\.consume_promo_grant[\s\S]*?\$\$;/,
    );
    expect(fn).not.toBeNull();
    expect(fn[0]).toMatch(/promo_benefit_cents\(/);
    expect(fn[0]).not.toMatch(/platform_fee_cents\(\s*p_amount_cents\s*,\s*1000\s*\)/);
  });

  test('the replacement preserves the guards the live function had gained', () => {
    // Reproducing a function from a stale migration file silently reverts everything
    // added since. These three were added after consume_promo_grant was first written
    // and MUST survive any future replacement.
    const fn = lifecycle.match(
      /create or replace function public\.consume_promo_grant[\s\S]*?\$\$;/,
    )[0];
    expect(fn).toMatch(/promotions_enabled/);      // the kill switch
    expect(fn).toMatch(/revoked_at is null/);      // revoked grants cannot be spent
    expect(fn).toMatch(/kind = 'fee_override'/);   // only fee promos apply here
  });

  test('release refuses to touch bookings (an AFTER-trigger write would roll back the decline)', () => {
    const fn = lifecycle.match(
      /create or replace function public\.release_booking_benefits[\s\S]*?\$\$;/,
    )[0];
    expect(fn).not.toMatch(/update public\.bookings/);
  });
  test('the redemption index stays inferrable by a bare ON CONFLICT (booking_id)', () => {
    // consume_poster_discount inserts with `on conflict (booking_id) do nothing`, and
    // ON CONFLICT inference cannot match a PARTIAL unique index. A previous version of
    // this migration made the index partial and every poster-discount consumption began
    // failing with 42P10 in production. If the index ever grows a WHERE clause again,
    // that writer has to change in the same commit.
    const idx = lifecycle.match(
      /create unique index[^;]*promo_redemptions_one_per_booking[^;]*;/,
    );
    expect(idx).not.toBeNull();
    expect(idx[0]).not.toMatch(/\bwhere\b/i);
    // And the migration must not resurrect the partial one.
    expect(lifecycle).not.toMatch(/create unique index[^;]*promo_redemptions_one_live_per_booking/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The honest 0% breakdown.
//
// At 0 bps the deduction does not vanish — platform_fee_cents floors at Stripe's cost
// so a free gig never settles at a loss. Showing "0%" while the earner watches money
// come off is the small dishonesty this split exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────
describe('feeBreakdown', () => {
  test('the parts always reconstruct the whole', () => {
    for (const amt of [500, 1005, 5000, 10000, 123456]) {
      for (const bps of [0, 200, 500, 1000, 3000]) {
        const b = feeBreakdown(amt, bps);
        expect(b.processingCents + b.platformCents).toBe(b.totalCents);
        expect(b.netCents + b.totalCents).toBe(amt);
        // And it must agree with the function the server mirrors.
        expect(b.totalCents).toBe(platformFeeCents(amt, bps));
      }
    }
  });

  test('a 0% rate still collects processing, and says so', () => {
    const b = feeBreakdown(10000, 0);
    expect(b.totalCents).toBe(345);        // the floor
    expect(b.processingCents).toBe(320);   // ceil(10000*0.029) + 30 — Stripe's
    expect(b.platformCents).toBe(25);      // the floor margin — ours, not hidden
    expect(b.isFloored).toBe(true);
  });

  test('a rate below the floor behaves exactly like 0%', () => {
    // 2% of $100 is $2.00, under the $3.45 floor — so 2% and 0% are the same charge.
    // Worth pinning: it is the reason a "2% platform fee" would not mean what it says.
    expect(feeBreakdown(10000, 200)).toEqual(feeBreakdown(10000, 0));
  });

  test('above the floor, the platform keeps the difference and nothing is floored', () => {
    const b = feeBreakdown(10000, 1000);
    expect(b.totalCents).toBe(1000);
    expect(b.processingCents).toBe(320);
    expect(b.platformCents).toBe(680);
    expect(b.isFloored).toBe(false);
  });

  test('processing is never reported as more than was actually taken', () => {
    // On a tiny amount platform_fee_cents clamps to the amount itself.
    const b = feeBreakdown(50, 0);
    expect(b.processingCents).toBeLessThanOrEqual(b.totalCents);
    expect(b.platformCents).toBeGreaterThanOrEqual(0);
    expect(b.netCents).toBeGreaterThanOrEqual(0);
  });

  test('a null rate does not become a free gig', () => {
    expect(feeBreakdown(10000, null).totalCents).toBe(platformFeeCents(10000, 1000));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A partial capture must never cost the platform money to settle.
//
// stripe-capture-payment scaled the full fee by the capture percentage:
//   feeCents = round(fullFee * pct)
// which is right for the percentage part and WRONG for the floor. Every fee is floored
// at `ceil(amount*0.029) + 30 + 25` — Stripe's processing plus a 25c margin — so fullFee
// may already BE that floor. Scaling it shrinks the fixed 30c+25c, while Stripe's own
// fixed 30c on the captured amount does not shrink.
//
// Verified against live pg_proc, both reachable today:
//   $200 gig, 765c credit, 50%  → scaled 318 vs Stripe cost 320  = platform pays 2c
//   $10 gig,  NO credit,   50%  → scaled  42 vs Stripe cost  45  = platform pays 3c
//
// The second needs no promotion at all, and 0.5 is a one-tap chip in the poster's own
// Verify sheet — so this fires on ordinary small gigs whenever a dispute is settled.
// ─────────────────────────────────────────────────────────────────────────────
describe('partial capture never settles below Stripe cost', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'supabase/functions/_shared/settleEscrow.ts'), 'utf8');
  // Strip comments before matching. The explanation of the bug necessarily QUOTES the
  // floor formula, and a naive /0.029/ then fires on the fix that documents itself — a
  // guard that fails on correct code is a guard someone deletes.
  const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const partial = code(src.slice(src.indexOf('if (capturePct < 1)'), src.indexOf('await stripe.paymentIntents.capture')));

  it('found the partial-capture branch', () => {
    expect(partial.length).toBeGreaterThan(200);
  });

  it('floors the scaled fee rather than shipping it raw', () => {
    // The bug was `Math.min(captureCents, Math.round(fullFeeCents * capturePct))` with no
    // lower bound at all.
    expect(partial).toMatch(/Math\.max\(\s*scaledFee/);
  });

  it('derives that floor from the ONE fee definition, not a local formula', () => {
    // CLAUDE.md: platform_fee_cents() is the single definition and all money paths call
    // it by RPC. Re-deriving `ceil(x*0.029)+30+25` here is how JS and SQL drift.
    expect(partial).toMatch(/rpc\(['"]platform_fee_cents['"]/);
    expect(partial).not.toMatch(/0\.029/);
  });

  it('fails closed if the floor cannot be computed', () => {
    // Guessing a fee is worse than refusing to capture — the same rule the fee
    // computation above it already follows.
    expect(partial).toMatch(/floorErr/);
    expect(partial).toMatch(/503/);
  });
});
