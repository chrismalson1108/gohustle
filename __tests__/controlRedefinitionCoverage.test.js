// ─────────────────────────────────────────────────────────────────────────────
// A control that gets redefined must not QUIETLY lose a shape it used to detect.
//
// On 2026-08-14 a migration redefined ctl_earner_credit_missing to change its TIP half and
// dropped its escrow half — "money captured from a poster and never credited to the
// earner" — because the new body was written from scratch instead of extended. It was
// caught in review, but only because someone happened to diff it.
//
// The consequence is worse than going blind. run_control auto-resolves anything a control
// stops returning, scoped only by control_key:
//     set resolved_at = now(), note = 'auto-resolved: no longer returned by the control'
// So the first sweep after such a migration silently CLOSES every open finding of the
// dropped shape — on real, unremediated money. The board goes green because the detector
// left, and nothing distinguishes that from the problem being fixed.
//
// Ten ctl_* functions have been redefined at least once, so this is not hypothetical.
//
// The check: every `kind` a control has EVER emitted must still be emitted by its latest
// definition. Kinds are the vocabulary these controls use to name what they found, and a
// dropped arm takes its kind with it. Deliberate removals go in RETIRED with a reason —
// which is the point: removing a detector should cost a sentence, not nothing.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'supabase', 'migrations');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();

// Kinds intentionally dropped, each with why. Empty is the healthy state.
const RETIRED = {
  // ── Renamed by 20260812080000_legacy_cleanup.sql, coverage kept or widened ──
  // Verified by reading both definitions: these are vocabulary changes, not lost arms.
  verified_without_payment_row:
    'renamed to completed_without_payment_row, and the predicate WIDENED — it now covers ' +
    'confirmed/completed bookings with no payment row, not only verified ones',
  verified_payment_not_captured:
    'renamed to settled_with_uncaptured_payment; same arm, clearer name',
  booking_has_no_slot: 'renamed to no_slot_id by the same cleanup',
  slot_row_missing: 'renamed to slot_missing by the same cleanup',
  slot_belongs_to_another_job: 'renamed to slot_belongs_to_other_job by the same cleanup',
};

// Body of the LAST definition of each ctl_ function, plus every kind it ever emitted.
const latestBody = {};
const everyKind = {};

for (const f of files) {
  const sql = fs.readFileSync(path.join(MIG, f), 'utf8');
  const re = /create or replace function public\.(ctl_[a-z0-9_]+)\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1];
    // From this definition to the revoke that always follows it, or the next definition.
    const from = m.index;
    const revoke = sql.indexOf(`revoke execute on function public.${name}`, from);
    const body = sql.slice(from, revoke === -1 ? sql.length : revoke);
    latestBody[name] = body;
    const kinds = [...body.matchAll(/'kind',\s*'([a-z0-9_]+)'/gi)].map((k) => k[1]);
    // CASE-selected kinds too — a control may pick a kind per row.
    const cased = [...body.matchAll(/then\s+'([a-z0-9_]+)'\s*$/gim)].map((k) => k[1]);
    (everyKind[name] ||= new Set());
    for (const k of [...kinds, ...cased]) everyKind[name].add(k);
  }
}

describe('a redefined control keeps every shape it could detect', () => {
  it('parsed the control corpus', () => {
    expect(Object.keys(latestBody).length).toBeGreaterThan(40);
  });

  it('no control silently lost a kind it used to emit', () => {
    const lost = [];
    for (const [name, kinds] of Object.entries(everyKind)) {
      const body = latestBody[name];
      for (const k of kinds) {
        if (RETIRED[k]) continue;
        if (!body.includes(`'${k}'`)) lost.push(`${name} no longer emits '${k}'`);
      }
    }
    // Name the control and the kind — "a control changed" is not actionable, and the
    // whole failure mode here is that nobody notices.
    expect(lost).toEqual([]);
  });

  it('ctl_earner_credit_missing keeps both of its arms', () => {
    // The specific one that was dropped. Asserted by NAME as well as by the generic rule
    // above, because this is the arm whose loss auto-resolves live findings about money
    // taken from a poster and never credited to the earner.
    const body = latestBody['ctl_earner_credit_missing'];
    expect(body).toContain('escrow_capture_not_credited');
    expect(body).toContain('tip_charged_not_credited');
    expect(body).toMatch(/from public\.payments p/i);
    expect(body).toMatch(/from public\.tip_ledger t/i);
  });

  it('every retired kind carries a reason', () => {
    for (const [kind, why] of Object.entries(RETIRED)) {
      expect(`${kind}: ${String(why).length > 20}`).toBe(`${kind}: true`);
    }
  });
});
