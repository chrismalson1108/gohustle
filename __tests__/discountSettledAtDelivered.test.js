const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// A partial capture must charge a poster-discount campaign only what it delivered.
//
// stripe-capture-payment scales the discount before it settles — `captureCents` is a
// percentage of the ALREADY-DISCOUNTED authorization, so the poster receives only `pct`
// of the discount, and the function passes
//
//     capturedGigCents = captureCents + Math.round(discountCents * capturePct)
//
// as `p_amount_cents`. settle_booking_benefits' poster_discount branch then ignored that
// argument entirely and read the FULL pinned `payments.poster_discount_cents` as the
// delivered figure, so a 50% capture charged the campaign 100% of the discount.
//
// DISCRIMINATES BY CONSTRUCTION: before 20260906074000 the newest definition of
// settle_booking_benefits was 20260813140000_settle_benefits_at_booking_rate.sql, whose
// poster_discount branch does not contain the string `p_amount_cents` anywhere — the
// argument reaches the function and is dropped on the floor. Checked out at that commit,
// every assertion in the first describe below fails.
//
// The arithmetic model at the bottom is not decoration: it is the figure the migration's
// own rolled-back probe asserts (178c of a 355c discount on a half capture), restated
// where a reader can see it without a database.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'supabase', 'migrations');

// The LAST migration that defines a function is the live one. Anything that reads an
// earlier copy is reading three revisions of stale — the exact mistake the 2026-08-12
// audit made about this very function.
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
  // Stop at whichever dollar-quote terminator closes this body, so a later function in
  // the same file cannot lend this one behaviour it does not have.
  const rest = sql.slice(start);
  const end = rest.search(/\$(?:function|\$)\$;/i);
  return { file, body: end === -1 ? rest : rest.slice(0, end) };
}

// The `if k = 'poster_discount' then … else` arm, on its own. Anchored on the OUTER
// `else` by its indentation — the branch contains a nested if/else of its own, and
// stopping at the first `else` would cut the arm in half and hide what it does.
function posterDiscountBranch(body) {
  const start = body.indexOf("if k = 'poster_discount' then");
  if (start === -1) return null;
  const after = body.slice(start);
  const end = after.search(/\n {1,4}else\b/);
  return end === -1 ? after : after.slice(0, end);
}

describe('settle_booking_benefits prices a poster discount at what the capture delivered', () => {
  const live = newestDefining('settle_booking_benefits');

  it('is defined somewhere', () => {
    expect(live).not.toBeNull();
  });

  it('still branches on the promotion kind', () => {
    // 20260813040000 established this; losing it re-opens the mirror defect where every
    // discount was refunded to its own campaign at capture.
    expect(`${live.file} branches on kind: ${posterDiscountBranch(live.body) !== null}`).toBe(
      `${live.file} branches on kind: true`,
    );
  });

  it('the poster_discount branch USES the settled gig value it is handed', () => {
    const branch = posterDiscountBranch(live.body);
    expect(`${live.file} reads p_amount_cents: ${branch.includes('p_amount_cents')}`).toBe(
      `${live.file} reads p_amount_cents: true`,
    );
  });

  it('scales the pinned discount by the FULL gig value, not by the discounted hold alone', () => {
    // The denominator has to be amount_cents + poster_discount_cents, because that is
    // what the caller's numerator (captured + scaled discount) is a share OF. Dividing by
    // amount_cents alone would over-state the delivered discount on every capture.
    const branch = posterDiscountBranch(live.body);
    expect(`${live.file} reads amount_cents: ${/\bamount_cents\b/.test(branch)}`).toBe(
      `${live.file} reads amount_cents: true`,
    );
    expect(
      `${live.file} sums the two into a gig total: ${/gig_total\s*:=\s*pay_auth\s*\+\s*pay_disc/.test(branch)}`,
    ).toBe(`${live.file} sums the two into a gig total: true`);
  });

  it('never charges a campaign more than the discount it pinned', () => {
    // A reconciliation that hands back slightly more than was authorized must not let the
    // ratio climb above 1 and bill the campaign for benefit it never offered.
    const branch = posterDiscountBranch(live.body);
    expect(`${live.file} clamps to the pinned discount: ${/least\(\s*\n?\s*pay_disc,/.test(branch)}`).toBe(
      `${live.file} clamps to the pinned discount: true`,
    );
  });

  it('keeps the fee_override counterfactual priced at the BOOKING time', () => {
    // 20260813140000. Rewriting this function is how that fix would be lost — the same
    // shape as the support-guard exemption two rewrites have already dropped.
    expect(
      `${live.file} passes booked_at: ${/promo_benefit_cents\(p_amount_cents,\s*r\.fee_bps,\s*booked_at\)/.test(live.body)}`,
    ).toBe(`${live.file} passes booked_at: true`);
  });
});

describe('the capture side still hands over a scaled gig value', () => {
  // Both halves of this contract have to agree. If capture stopped scaling the discount,
  // the ratio above would read 1 on a partial and the defect would be back with the
  // database looking innocent.
  const SRC = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'stripe-capture-payment', 'index.ts'),
    'utf8',
  );

  it('scales the discount into capturedGigCents on a partial capture', () => {
    expect(SRC).toMatch(
      /capturedGigCents = captureCents \+ Math\.round\(discountCents \* capturePct\)/,
    );
  });

  it('re-derives the same scaled figure on the already-captured recovery path', () => {
    expect(SRC).toMatch(
      /capturedGigCents = settledTotal \+ Math\.round\(discountCents \* observedPct\)/,
    );
  });
});

describe('a control watches the invariant against data', () => {
  const sql = fs.readFileSync(
    path.join(DIR, '20260906074000_a_partial_capture_charged_the_campaign_the_whole_discount.sql'),
    'utf8',
  );

  it('defines ctl_discount_settled_above_delivered', () => {
    expect(sql).toMatch(
      /create or replace function public\.ctl_discount_settled_above_delivered\(\)/,
    );
  });

  it('registers it, or run_all_controls never calls it', () => {
    // run_all_controls iterates the REGISTRY, so an unregistered ctl_ function never runs
    // and the board still shows green.
    expect(sql).toMatch(/insert into public\.controls[\s\S]*'discount_settled_above_delivered'/);
    expect(sql).toMatch(/'ctl_discount_settled_above_delivered'\)/);
  });

  it('returns the (entity_id, detail) shape every other control returns', () => {
    expect(sql).toMatch(
      /ctl_discount_settled_above_delivered\(\)\s*\nreturns table \(entity_id text, detail jsonb\)/,
    );
  });
});

describe('the figure itself', () => {
  // The migration's arithmetic, restated so it can be read without a database.
  // $100 gig at 700 bps: platform_fee_cents(10000, 700) = 700, floored at
  // ceil(10000 * 0.029) + 30 + 25 = 345, so the headroom — and the discount — is 355c
  // and the authorized hold is 9645c.
  const DISCOUNT = 355;
  const AUTHORIZED = 9645;
  const GIG_TOTAL = AUTHORIZED + DISCOUNT;

  // What stripe-capture-payment passes as p_amount_cents.
  const capturedGigCents = (pct) =>
    Math.max(1, Math.round(AUTHORIZED * pct)) + Math.round(DISCOUNT * pct);

  // What settle_booking_benefits now charges the campaign.
  const delivered = (amountCents) =>
    Math.max(
      0,
      Math.min(DISCOUNT, Math.round((DISCOUNT * Math.min(amountCents, GIG_TOTAL)) / GIG_TOTAL)),
    );

  it('a full capture is unchanged: the campaign is charged the whole discount', () => {
    expect(capturedGigCents(1)).toBe(GIG_TOTAL);
    expect(delivered(GIG_TOTAL)).toBe(DISCOUNT);
  });

  it('a half capture charges 178c, not 355c', () => {
    expect(capturedGigCents(0.5)).toBe(5001);
    expect(delivered(5001)).toBe(178);
    // The old body's answer, and the 177c the campaign was over-charged for benefit
    // nobody received.
    expect(DISCOUNT - delivered(5001)).toBe(177);
  });

  it('every settlement between the floor and full is bounded by the pinned discount', () => {
    // capturePctFinal is clamped to [0.5, 1] by stripe-capture-payment, so those are the
    // only ratios reachable — and none of them may charge more than was offered.
    for (let pct = 0.5; pct <= 1.0001; pct += 0.05) {
      const amount = capturedGigCents(Math.min(1, pct));
      const d = delivered(amount);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(DISCOUNT);
      // Within a cent of the figure the caller itself scaled — the two roundings are
      // allowed to disagree by one, which is the slack the control gives.
      expect(Math.abs(d - Math.round(DISCOUNT * Math.min(1, pct)))).toBeLessThanOrEqual(1);
    }
  });
});
