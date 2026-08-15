// ─────────────────────────────────────────────────────────────────────────────
// The audit row goes down BEFORE the thing it records, not after.
//
// audit() throws on an insert failure (admin/lib/audit.ts) and every console action wraps
// its body in a catch that converts anything into a generic message. So an audit call
// placed after the mutation means a crash — or a problem with the audit table itself —
// between the two leaves the change made and nobody recorded as having made it.
//
// The failure mode is specifically nasty: admin_audit_log ends up missing exactly the rows
// from the runs that went wrong, while looking complete. A log you cannot tell is missing
// entries is worse than no log.
//
// admin-payment-action is the sharpest case and had its own version of this. Its header
// asserted "the console writes its admin_audit_log row BEFORE calling this, so an action
// that reaches Stripe is always already on the record" — and nothing enforced it. The
// function authenticates the OPERATOR's own JWT, so that same token can be POSTed straight
// at the endpoint with no console involved, and three money ops ran unlogged.
//
// Found by the 2026-08-12 audit; reproduced against current code on 2026-08-14.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the money edge function records itself', () => {
  const fn = codeOnly(read('supabase', 'functions', 'admin-payment-action', 'index.ts'));

  it('writes its own admin_audit_log row', () => {
    // Not the console's row: this endpoint is reachable without the console at all.
    expect(fn).toMatch(/from\(['"]admin_audit_log['"]\)\s*\.insert/);
  });

  it('writes it BEFORE anything reaches Stripe', () => {
    const auditAt = fn.indexOf("admin_audit_log");
    const stripeAt = Math.min(
      ...['stripe.refunds.create', 'stripe.paymentIntents.cancel', 'stripe.paymentIntents.retrieve']
        .map((c) => { const i = fn.indexOf(c); return i === -1 ? Number.MAX_SAFE_INTEGER : i; }),
    );
    expect(auditAt).toBeGreaterThan(-1);
    expect(stripeAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(auditAt).toBeLessThan(stripeAt);
  });

  it('fails CLOSED when the audit write fails', () => {
    // An untraceable money action is worse than a refused one; the operator can retry.
    expect(fn).toMatch(/audit_unavailable/);
    const after = fn.slice(fn.indexOf('admin_audit_log'));
    expect(after.slice(0, 900)).toMatch(/return json\(/);
  });

  it('does not still claim the console guarantees the row', () => {
    const header = read('supabase', 'functions', 'admin-payment-action', 'index.ts').slice(0, 1400);
    expect(header).not.toMatch(/console writes its admin_audit_log row BEFORE calling this, so an\n\/\/ action that reaches Stripe is always already on the record/);
  });
});

describe('console actions audit before they mutate', () => {
  // The highest-leverage ones. Not every action in the console — the point is the actions
  // whose loss of attribution actually matters: the rate card, a direct grant, and
  // switching a control off.
  const CASES = [
    // The marker must be the MUTATION, not any touch of the table — resolveFinding reads
    // the row first to capture its before-state, and matching that select would compare
    // the audit call against the wrong statement.
    ['controls/actions.ts', 'control_finding.resolve', '.update({ resolved_at'],
    ['controls/actions.ts', 'control.enable', 'from("controls")'],
    ['pricing/actions.ts', 'pricing.set_rate', 'from("platform_rates")'],
    ['pricing/actions.ts', 'promotion.grant_direct', 'grant_promotion_to_users'],
  ];

  CASES.forEach(([file, action, mutation]) => {
    it(`${file}: ${action} is recorded before ${mutation}`, () => {
      const src = codeOnly(read('admin', 'app', '(console)', ...file.split('/')));
      const auditAt = src.indexOf(action);
      const mutAt = src.indexOf(mutation, Math.max(0, auditAt - 3000));
      expect(auditAt).toBeGreaterThan(-1);
      expect(mutAt).toBeGreaterThan(-1);
      expect(`${action}: ${auditAt < mutAt ? 'before' : 'AFTER THE MUTATION'}`)
        .toBe(`${action}: before`);
    });
  });
});
