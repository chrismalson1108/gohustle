// ─────────────────────────────────────────────────────────────────────────────
// Hustlr AI has ONE system prompt and TWO clients, and until 2026-09-05 half of what
// it said about money was false on one of them.
//
// `supabase/functions/assistant/index.ts` builds a single prompt with no platform
// argument. The widget is mounted in web/app/(app)/layout.tsx, so a web user asking
// "did my deposit arrive?" was told to open the Bank deposits list on the Transactions
// screen. The web had no such screen and no such data layer: no web/lib/payments.ts,
// no /transactions route, and a repo-wide grep of web/ for `.from("…")` listed neither
// `payments` nor `stripe_payouts`. Its own Tax Center said as much in a comment — "the
// authoritative per-booking net is payments.earner_amount_cents, which this screen does
// not load". The prompt's own rule is "Never invent a screen"; the prompt was doing it.
//
// parity.test.js already asserts the PROMPT can name these destinations. This asserts
// the destinations EXIST on both clients — which is the half that was missing, and the
// half that decides whether the answer is true.
//
// It also pins the anti-duplication property the fix depends on: the money arithmetic
// lives once, in shared/ledger.js. A second hand-written copy on the web would drift —
// the fee is pinned per booking, the refund share differs by side, and a partial
// capture deliberately leaves amount_cents at the full authorization.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
// A missing file here IS the finding — the web had none of these. Say which one, so
// the failure reads as "the web lost its ledger" rather than a bare ENOENT stack.
const read = (p) => {
  if (!exists(p)) return `MISSING FILE: ${p}`;
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
};

const WEB_APP = path.join(ROOT, 'web', 'app');

// Every file under web/app, so a route claim is checked against the tree rather than
// against a list someone has to remember to update.
function webFiles(dir = WEB_APP, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) webFiles(full, out);
    else out.push(path.relative(ROOT, full));
  }
  return out;
}

describe('the money destinations the assistant names exist on BOTH clients', () => {
  const prompt = read('supabase/functions/assistant/index.ts');
  const files = webFiles();

  // [what the prompt promises, the mobile screen, the web route file]
  const DESTINATIONS = [
    ['Transactions', 'src/screens/PaymentsScreen.js', 'web/app/(app)/profile/transactions/page.tsx'],
    ['Tax Center', 'src/screens/ExpensesScreen.js', 'web/app/(app)/profile/taxes/page.tsx'],
    ['Payments & payouts', 'src/screens/PayoutSetupScreen.js', 'web/app/(app)/profile/payouts/page.tsx'],
  ];

  DESTINATIONS.forEach(([what, mobile, web]) => {
    it(`${what} exists on mobile and on the web`, () => {
      expect(`${what} mobile:${exists(mobile)} web:${exists(web)}`)
        .toBe(`${what} mobile:true web:true`);
      expect(files).toContain(web);
    });
  });

  it('the prompt still points at Transactions and Bank deposits', () => {
    // If this ever stops being true, the assertions above are guarding nothing.
    expect(prompt).toMatch(/Transactions/);
    expect(prompt).toMatch(/Bank deposits/);
  });
});

describe('the web actually reads the ledger tables', () => {
  const lib = read('web/lib/payments.ts');

  it('reads payments and stripe_payouts', () => {
    // The two tables the whole statement is made of. Before this file, a grep of web/
    // found neither.
    expect(lib).toMatch(/from\("payments"\)/);
    expect(lib).toMatch(/from\("stripe_payouts"\)/);
  });

  it('splits earner and poster with TWO booking queries, as mobile does', () => {
    // RLS exposes a payment through either policy and one select cannot tell which
    // side the reader is on — the difference between "you earned $54" and "you paid
    // $60". A single query here would mislabel every poster's row.
    expect(lib).toMatch(/eq\("earner_id", userId\)/);
    expect(lib).toMatch(/eq\("jobs\.poster_id", userId\)/);
  });

  it('does not swallow a failed read into an empty statement', () => {
    // `?? []` on an errored response turns "we could not load your money" into "you
    // have no transactions", on the page people open when they are anxious about it.
    expect(lib).toMatch(/if \(asEarner\.error\) throw asEarner\.error;/);
    expect(lib).toMatch(/if \(asPoster\.error\) throw asPoster\.error;/);
  });
});

describe('the ledger arithmetic exists exactly once', () => {
  const shared = read('shared/ledger.js');
  const mobile = read('src/lib/payments.js');
  const web = read('web/lib/payments.ts');

  // The functions that restate money. Each must be DEFINED in shared/ and defined in
  // neither client.
  const PURE = [
    'paymentState',
    'settledGrossCents',
    'earnerRefundShareCents',
    'toEntry',
    'summarize',
    'filterEntries',
    'stats',
    'monthlyTotals',
    'byMonth',
    'ledgerCsv',
    'receiptLines',
    'payoutState',
  ];

  PURE.forEach((fn) => {
    it(`${fn} is defined in shared/ledger.js and nowhere else`, () => {
      const defined = (src) => new RegExp(`function ${fn}\\s*\\(`).test(src);
      expect(`${fn} shared:${defined(shared)} mobile:${defined(mobile)} web:${defined(web)}`)
        .toBe(`${fn} shared:true mobile:false web:false`);
    });
  });

  it('both clients re-export it rather than reimplementing it', () => {
    expect(mobile).toMatch(/export \* from '\.\.\/\.\.\/shared\/ledger'/);
    expect(web).toMatch(/from "@gohustlr\/shared"/);
  });

  it('shared/ledger.js is on the web barrel', () => {
    // Without this line the web import resolves to nothing and the page renders
    // undefined helpers rather than failing at build.
    expect(read('shared/index.js')).toMatch(/export \* from '\.\/ledger\.js';/);
  });

  it('neither client re-derives the fee from the current rate card', () => {
    // CLAUDE.md: "anything showing an existing booking uses THAT booking's
    // feeBpsQuoted. Using the wrong one is a disclosure bug." getFeeBps() is the
    // quoting path and has no business in a statement of what already happened.
    expect(web).not.toMatch(/getFeeBps/);
    expect(mobile).not.toMatch(/getFeeBps/);
  });
});

describe('a web user can reach the ledger from more than one place', () => {
  const settings = read('web/app/(app)/settings/page.tsx');
  const payouts = read('web/app/(app)/profile/payouts/page.tsx');
  const hiring = read('web/app/(app)/hiring/page.tsx');
  const myJobs = read('web/app/(app)/my-jobs/page.tsx');

  it('Settings → Money lists Transactions, as mobile does', () => {
    expect(settings).toMatch(/href: "\/profile\/transactions"/);
  });

  it('the money hub links it', () => {
    expect(payouts).toMatch(/\/profile\/transactions/);
  });

  it('BOTH sides can reach it from their own hub', () => {
    // CLAUDE.md records the mobile gap: nothing in GigsStack navigates to Payments,
    // "so a poster cannot reach their own ledger from the Hire tab. That is a gap,
    // not a design." The web does not inherit it.
    expect(myJobs).toMatch(/\/profile\/transactions/);
    expect(hiring).toMatch(/\/profile\/transactions/);
  });
});
