// ─────────────────────────────────────────────────────────────────────────────
// The control that detects unledgered reversals must be able to READ what the
// webhook writes.
//
// On 2026-08-13 a migration correctly dropped this control's pre-Basil arithmetic and,
// in the same edit, replaced the CTE that selects its input rows: from
// `ilike 'Stripe refund on charge%'` (what stripe-webhook writes) to
// `like '%reversal_cents=%'` (a string that appears nowhere in this repo). The
// chargeback arm survived on `%chargeback%`; the refund arm matched nothing that has
// ever existed. So the fix for "unledgered refunds smaller than the partial-capture
// gap are invisible" shipped as "EVERY external refund is invisible".
//
// It passed its own discrimination probe, because the probe staged a synthetic reason
// in the format the new parser expected. A probe that writes its own input proves the
// parser can read the probe.
//
// So this asserts the two halves against each other directly:
//
//   stripe-webhook's reason templates  ⟷  the control's ILIKE patterns + cents regex
//
// Change either side alone and this fails, naming the reason string that stopped
// matching. It reads the LATEST migration defining the function, so a future rewrite
// is checked, not the historical one.
//
// ── AND THE ANCHORED HALF, WHICH THIS FILE USED TO IGNORE ───────────────────
//
// 20260814060000 then made the filter TWO conditions per arm: the ilike prefix as a cheap
// scan filter, plus an anchored `~ '^Stripe refund on charge (ch|py)_… \([a-z]{3} …\)$'`
// that separates the webhook's template from a poster's typed "report a problem" note.
// Its header said as much — the ilike prefixes "are the half this test reads", and the
// regexes were checked once, by literals typed into that migration's own probe.
//
// So the guard covered the loose half and not the strict one: a webhook edit that kept
// the prefix and changed the shape (uppercase currency, a thousands separator, a new id
// family) left `npm test` green while the control silently selected nothing — which is
// the 2026-08-13 regression above, reintroduced with no failing test. The anchored
// patterns are now extracted from the live body and matched against the same sampled
// reasons, and a hand-typed note is asserted to pass the prefix and FAIL the anchor,
// because a strict pattern that rejects nothing is not doing the job it was added for.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const webhook = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', 'stripe-webhook', 'index.ts'),
  'utf8',
);

const FN_NAME = 'ctl_external_reversal_not_ledgered';
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');

// The live body is whichever migration defines it last — same rule Postgres applies.
function latestBody() {
  const defining = fs
    .readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      new RegExp(`create or replace function public\\.${FN_NAME}`, 'i').test(
        fs.readFileSync(path.join(MIG_DIR, f), 'utf8'),
      ),
    );
  const last = defining[defining.length - 1];
  const sql = fs.readFileSync(path.join(MIG_DIR, last), 'utf8');
  // Only the function body — the file's header comment quotes the OLD broken patterns
  // on purpose, and matching those would make this test pass on the bug it exists for.
  const start = sql.search(new RegExp(`create or replace function public\\.${FN_NAME}`, 'i'));
  const end = sql.indexOf('$function$;', start);
  return { file: last, body: sql.slice(start, end === -1 ? undefined : end) };
}

// Fill a webhook template literal with values of the shape Stripe actually produces.
// `amount`/`refunded` are both `(cents / 100).toFixed(2)` at the call site.
function sample(expr) {
  const base = (() => {
    if (/refunded|amount/.test(expr)) return '35.00';
    if (/dispute\.id/.test(expr)) return 'dp_1AbCdEfGhIjKlMnO';
    if (/charge\.id/.test(expr)) return 'ch_3AbCdEfGhIjKlMnO';
    if (/currency/.test(expr)) return 'usd';
    if (/reason/.test(expr)) return 'fraudulent';
    return 'x';
  })();
  // Honour case transforms written into the interpolation. Without this a webhook edit
  // to `${(charge.currency ?? 'usd').toUpperCase()}` — matching the email subject line,
  // and the exact shape that breaks the anchored `[a-z]{3}` — would sample as lowercase
  // and this file would report it as fine.
  if (/toUpperCase\s*\(/.test(expr)) return base.toUpperCase();
  if (/toLowerCase\s*\(/.test(expr)) return base.toLowerCase();
  return base;
}

// Every template literal handed to recordReversal() as its reason argument.
function webhookReasons() {
  const out = [];
  for (const m of webhook.matchAll(/`(Stripe [^`]*)`/g)) {
    out.push(m[1].replace(/\$\{([^}]*)\}/g, (_, e) => sample(e)));
  }
  return out;
}

function ilikeToRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i');
}

const { file, body } = latestBody();
const reasons = webhookReasons();

// The patterns the CTE filters disputes.reason on, and the figure it parses out.
const patterns = [...body.matchAll(/i?like\s+'([^']+)'/gi)].map((m) => m[1]);
const centsRegex = (() => {
  const m = body.match(/substring\(\s*\w+\.reason\s+from\s+'([^']+)'\s*\)/i);
  return m ? m[1] : null;
})();

// The ANCHORED patterns — the authenticity half. `~ '…'` in the live body, with SQL's
// doubled-quote escape undone. POSIX and JS agree on everything these use.
const anchored = [...body.matchAll(/~\s*'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));

// Free text a PERSON types, which lands in the same column from the "report a problem"
// flow. Each of these is deliberately built to slip past the cheap prefix filter: the
// anchored patterns are the only thing standing between them and the control's board.
const TYPED_NOTES = [
  'Stripe chargeback incoming — half the work was never done',
  'Stripe refund on charge please, they never showed up (usd 35.00 refunded)',
  'Stripe refund on charge ch_1 (usd 35.00 refunded)',
];

describe('reversal control reads the reasons the webhook writes', () => {
  it('parsed both sides', () => {
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    expect(patterns.length).toBeGreaterThanOrEqual(2);
    expect(centsRegex).not.toBeNull();
  });

  it('recordReversal writes both a refund and a chargeback reason', () => {
    // If these stop existing the rest of this file is asserting nothing.
    expect(reasons.some((r) => /refund/i.test(r))).toBe(true);
    expect(reasons.some((r) => /chargeback/i.test(r))).toBe(true);
  });

  it(`every reason the webhook writes is selected by ${FN_NAME}`, () => {
    const res = patterns.map(ilikeToRegExp);
    const unmatched = reasons.filter((r) => !res.some((re) => re.test(r)));
    // Name the string, not the count — "a pattern drifted" is not actionable.
    expect({ migration: file, unmatched }).toEqual({ migration: file, unmatched: [] });
  });

  it('the cents parser recovers the refunded figure from a real refund reason', () => {
    const refund = reasons.find((r) => /refunded\)/.test(r));
    expect(refund).toBeDefined();
    const m = refund.match(new RegExp(centsRegex));
    expect(m).not.toBeNull();
    // 'usd 35.00 refunded)' → 3500 cents, the figure the control compares.
    expect(Math.round(Number(m[1]) * 100)).toBe(3500);
  });

  it('a chargeback reason parses to NULL, taking the refunded_cents branch', () => {
    // Documented behaviour, and load-bearing: a chargeback carries no cents figure, so
    // the control falls through to "refunded_cents = 0 means nothing was ledgered".
    const chargeback = reasons.find((r) => /chargeback/i.test(r));
    expect(chargeback).toBeDefined();
    expect(chargeback.match(new RegExp(centsRegex))).toBeNull();
  });

  it('keeps an anchored pattern per arm, not just the prefix', () => {
    // If a rewrite drops these, the control is back to selecting any note that starts
    // with "Stripe refund on charge" — which is what the prefix alone means.
    expect({ migration: file, anchored: anchored.length }).toEqual({ migration: file, anchored: 2 });
    expect(anchored.every((p) => p.startsWith('^') && p.endsWith('$'))).toBe(true);
  });

  it(`every reason the webhook writes ALSO satisfies ${FN_NAME}'s anchored pattern`, () => {
    const res = anchored.map((p) => new RegExp(p));
    const unmatched = reasons.filter((r) => !res.some((re) => re.test(r)));
    // The failure this exists for: a template edit that keeps the prefix and changes the
    // shape leaves the ilike assertion above green and empties the control.
    expect({ migration: file, unmatched }).toEqual({ migration: file, unmatched: [] });
  });

  it('a hand-typed note passes the prefix and is rejected by the anchor', () => {
    const prefixes = patterns.map(ilikeToRegExp);
    const strict = anchored.map((p) => new RegExp(p));
    // With no anchored patterns "nothing was accepted" is vacuously true, and this test
    // would report a control that rejects nothing as healthy.
    expect(strict.length).toBeGreaterThan(0);
    // Both halves have to be doing work: the note must reach the anchored test at all,
    // and the anchored test must be what throws it out.
    const notSelectedByPrefix = TYPED_NOTES.filter((n) => !prefixes.some((re) => re.test(n)));
    const acceptedByAnchor = TYPED_NOTES.filter((n) => strict.some((re) => re.test(n)));
    expect({ notSelectedByPrefix, acceptedByAnchor }).toEqual({
      notSelectedByPrefix: [],
      acceptedByAnchor: [],
    });
  });

  it('filters only on tokens something in the repo actually writes', () => {
    // The specific regression: a pattern keyed on 'reversal_cents=' selected nothing but
    // the migration's own probe. Any literal token the CTE keys on must have a writer.
    const tokens = patterns
      .map((p) => p.replace(/%/g, '').trim())
      .filter((t) => t.length > 3);
    const orphans = tokens.filter((t) => codeWriters(t).length === 0);
    expect({ migration: file, tokensWithNoWriter: orphans }).toEqual({
      migration: file,
      tokensWithNoWriter: [],
    });
  });
});

// Which source files (not migrations, not this test) emit a given literal.
function codeWriters(needle) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(needle)) {
        hits.push(path.relative(ROOT, p));
      }
    }
  };
  for (const d of ['supabase/functions', 'admin', 'src', 'web', 'shared']) {
    const full = path.join(ROOT, d);
    if (fs.existsSync(full)) walk(full);
  }
  return hits;
}
