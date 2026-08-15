const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Tips are the one fee-free, card-funded, daily-payout rail in the product, and both
// halves of it were broken in ways the previous version of this file could not see.
//
// 1. THE CAP GATE WAS A READ. The twelve tests here asserted "checked before the
//    charge" and "the caps are serialised" and were green the whole time, because both
//    statements are true of the two transactions taken one at a time. What was never
//    asserted is that the pre-charge gate CONSUMES anything. `tip_headroom_cents` was
//    `stable` and lock-free, in its own round trip; N concurrent callers all read the
//    same headroom and all passed, and because the idempotency key was
//    `tip_${booking}_${cents}`, varying the amount by a cent produced N distinct
//    PaymentIntents that never collided. The trigger's advisory locks fired afterwards,
//    at credit time, after the card was charged — and each rejection rolled back its own
//    ledger row, so the over-cap money never tightened the cap for the next attempt.
//    The gate is now `reserve_tip_slot`, a WRITE that goes through the same trigger.
//
// 2. A REVERSED TIP WAS RECORDED NOWHERE. Every reversal path is keyed on `payments`
//    and a tip writes no payments row, so nothing ledgered a refunded or charged-back
//    tip and ctl_earnings_total_drift reported the result as healthy.
//
// So this file asserts the SHAPE of the gate (a write, not a read), the single-definition
// rule (the trigger owns the cap arithmetic; nothing else may restate it), and the
// reversal writer's cumulative-target semantics.
//
// Everything below reads COMMENT-STRIPPED source. Four guards in this repo have been
// satisfied by the prose explaining them rather than the code doing them, and this file's
// own header quotes the broken idempotency key on purpose.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');

// ── Comment strippers ────────────────────────────────────────────────────────
// Quote-aware, because a `--` inside a string literal is code, not commentary. Dollar
// quotes are pushed/popped rather than skipped, so comments INSIDE a plpgsql body — which
// is where every assertion below actually looks — are removed too.
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

function stripTsComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === ch) { j += 1; break; }
        j += 1;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ── Sources ──────────────────────────────────────────────────────────────────
const NEW_MIGRATION = '20260814090000_tip_reservation_and_reversal.sql';
const migrationRaw = fs.readFileSync(path.join(MIG_DIR, NEW_MIGRATION), 'utf8');
const migration = stripSqlComments(migrationRaw);
const edgeRaw = fs.readFileSync(path.join(ROOT, 'supabase/functions/stripe-tip/index.ts'), 'utf8');
const edge = stripTsComments(edgeRaw);
// Raw on purpose: the reason templates are extracted from backticked literals, exactly
// as reversalReasonParity.test.js does.
const webhookRaw = fs.readFileSync(path.join(ROOT, 'supabase/functions/stripe-webhook/index.ts'), 'utf8');

// Postgres keeps whichever definition ran last. So does this — the old file's text is
// still on disk and asserting against it would pin a body the database has replaced.
function latestDefining(fnName) {
  const files = fs
    .readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      new RegExp(`create or replace function public\\.${fnName}\\b`, 'i').test(
        fs.readFileSync(path.join(MIG_DIR, f), 'utf8'),
      ),
    );
  const last = files[files.length - 1];
  return { file: last, sql: stripSqlComments(fs.readFileSync(path.join(MIG_DIR, last), 'utf8')) };
}

// Signature + body of one function, stopping at its dollar-quote terminator.
function bodyOf(sql, name) {
  const start = sql.search(new RegExp(`create or replace function public\\.${name}\\b`, 'i'));
  if (start === -1) return '';
  const tagM = sql.slice(start).match(/\bas\s+(\$[a-zA-Z_]*\$)/);
  if (!tagM) return '';
  const bodyStart = start + tagM.index + tagM[0].length;
  const end = sql.indexOf(tagM[1], bodyStart);
  return sql.slice(start, end === -1 ? undefined : end);
}

const guardSrc = latestDefining('guard_tip_caps');
const guard = bodyOf(guardSrc.sql, 'guard_tip_caps');
const helperSrc = latestDefining('tip_headroom_cents');
const helper = bodyOf(helperSrc.sql, 'tip_headroom_cents');
const reserve = bodyOf(migration, 'reserve_tip_slot');
const confirm = bodyOf(migration, 'confirm_tip_charge');
const release = bodyOf(migration, 'release_tip_reservation');
const reversal = bodyOf(migration, 'record_tip_reversal');
const driftSrc = latestDefining('ctl_earnings_total_drift');
const drift = bodyOf(driftSrc.sql, 'ctl_earnings_total_drift');
const staleTip = bodyOf(latestDefining('ctl_earner_credit_missing').sql, 'ctl_earner_credit_missing');

// The predicate that makes a reservation consume headroom while it is live and stop the
// moment it expires. It is the single reason a dead invocation cannot hold a cap hostage.
const LIVE_SLOT = 'reserved_until is null or t.reserved_until > now()';

describe('the comment strippers actually strip', () => {
  // A guard that reads its own explanation is worse than no guard. These check the two
  // strippers against the real files, not against a sample written to suit them.
  it('removes SQL commentary from inside a plpgsql body', () => {
    expect(migrationRaw).toContain('-- IDEMPOTENT REPLAY');
    expect(migration).not.toContain('IDEMPOTENT REPLAY');
    // ...while leaving the code in that same body alone.
    expect(migration).toContain('pg_advisory_xact_lock');
  });

  it('leaves a -- that is inside a string literal alone', () => {
    const sample = stripSqlComments("select 'a -- b' as x; -- gone\nselect 2;");
    expect(sample).toContain("'a -- b'");
    expect(sample).not.toContain('gone');
  });

  it('removes TS commentary but keeps template literals', () => {
    expect(edgeRaw).toContain('// This used to be');
    expect(edge).not.toContain('This used to be');
    expect(edge).toContain('idempotencyKey: reservationKey');
  });
});

describe('the pre-charge gate is a WRITE that consumes headroom', () => {
  it('stripe-tip reserves a slot instead of reading the headroom', () => {
    expect(edge).toContain("rpc('reserve_tip_slot'");
    // The read gate is what made the cap bypassable. It has no business on the charge
    // path any more; it survives only inside reserve_tip_slot, for the refusal copy.
    expect(edge).not.toContain("rpc('tip_headroom_cents'");
  });

  it('the reservation is taken BEFORE the card is charged', () => {
    const gate = edge.indexOf("rpc('reserve_tip_slot'");
    const charge = edge.indexOf('stripe.paymentIntents.create');
    expect(gate).toBeGreaterThan(-1);
    expect(charge).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(charge);
  });

  it('reserve_tip_slot really is a write against tip_ledger', () => {
    // The whole fix is that the gate inserts. If this ever became a select again the
    // caps would go back to being advisory, silently, with every test still green.
    expect(reserve).toMatch(/insert into public\.tip_ledger/);
    const gateSeg = edge.slice(edge.indexOf("rpc('reserve_tip_slot'"), edge.indexOf('stripe.paymentIntents.create'));
    expect(gateSeg).toMatch(/if \(capErr\)/);
    expect(gateSeg).toMatch(/return json\(/);
  });

  it('a failed reservation refuses the tip rather than charging blind', () => {
    const gateSeg = edge.slice(edge.indexOf("rpc('reserve_tip_slot'"), edge.indexOf('stripe.paymentIntents.create'));
    expect(gateSeg).toMatch(/if \(!reservation\?\.ok\)/);
    expect(gateSeg).toMatch(/}, 409\)/);
  });

  it('the Stripe idempotency key is the reservation, not booking+amount', () => {
    // booking+amount is what let an attacker mint N non-colliding PaymentIntents by
    // varying the amount a cent at a time. The reservation key is the row that consumed
    // the headroom, so a second charge cannot exist without a second reservation.
    expect(edge).toMatch(/idempotencyKey: reservationKey/);
    expect(edge).not.toMatch(/idempotencyKey: `tip_\$\{/);
    expect(reserve).toMatch(/'resv_' \|\| p_booking::text \|\| '_' \|\| p_cents::text/);
  });

  it('a definitively dead charge gives the slot back, an ambiguous one does not', () => {
    const catchSeg = edge.slice(edge.indexOf('} catch (chargeErr'), edge.indexOf('if (pi.status !== '));
    expect(catchSeg).toMatch(/StripeCardError/);
    expect(catchSeg).toMatch(/rpc\('release_tip_reservation'/);
    // Releasing on a timeout would let a second charge in beside a first that may have
    // succeeded, so the release must sit inside the decline test rather than beside it.
    expect(catchSeg.indexOf('StripeCardError')).toBeLessThan(catchSeg.indexOf('release_tip_reservation'));
    expect(catchSeg).toMatch(/throw chargeErr/);
  });

  it('the charge is confirmed onto the reservation afterwards', () => {
    const charge = edge.indexOf('stripe.paymentIntents.create');
    const confirmCall = edge.indexOf("rpc('confirm_tip_charge'");
    expect(confirmCall).toBeGreaterThan(charge);
    // A false return is a charged-but-unrecorded tip just as much as an error is. Testing
    // only the error would let the loudest failure in this whole function return 200.
    expect(edge).toMatch(/if \(creditErr \|\| confirmed !== true\)/);
  });

  it('a tip charged but not credited is reported as fatal, not swallowed', () => {
    const seg = edge.slice(edge.indexOf("rpc('confirm_tip_charge'"));
    expect(seg).toContain('logServerError');
    expect(seg).toMatch(/fatal: true/);
    // The operator needs the handle that recovers it.
    expect(seg).toMatch(/reservation_key: reservationKey/);
  });
});

describe('the trigger remains the single definition of the caps', () => {
  it('reads the guard from whichever migration defines it last', () => {
    expect(guardSrc.file).toBe(NEW_MIGRATION);
    expect(helperSrc.file).toBe(NEW_MIGRATION);
    expect(guard).not.toBe('');
    expect(helper).not.toBe('');
  });

  it('the trigger fires BEFORE INSERT on tip_ledger', () => {
    expect(migration).toMatch(/create trigger trg_guard_tip_caps\s+before insert on public\.tip_ledger/);
  });

  it('the guard does NOT exempt service_role', () => {
    // tip_ledger's only writer IS the service role; exempting it disables the cap.
    expect(guard).not.toMatch(/service_role/);
  });

  it('all three caps are enforced', () => {
    for (const cap of ['tip_cap_count', 'tip_cap_booking', 'tip_cap_velocity']) {
      expect(guard).toContain(cap);
    }
  });

  it('the per-booking cap is relative to what the booking actually CAPTURED', () => {
    // amount_cents is the original authorization and is never rewritten, so using it
    // would let a partially-captured $400 hold justify tips against the full $400.
    expect(guard).toMatch(/earner_amount_cents[\s\S]{0,60}fee_cents/);
    expect(guard).toMatch(/status = 'captured'/);
  });

  it('an idempotent replay is exempt, and a RESERVATION never is', () => {
    // claim_and_credit_tip does `insert ... on conflict (payment_intent_id) do nothing`,
    // and a BEFORE INSERT row trigger fires BEFORE conflict arbitration. Without the
    // exemption the guard re-counts the already-stored row on a retry and aborts the
    // credit transaction, stranding a charged tip uncredited.
    const exemption = guard.indexOf('where payment_intent_id = new.payment_intent_id');
    expect(exemption).toBeGreaterThan(-1);
    for (const cap of ['tip_cap_count', 'tip_cap_booking', 'tip_cap_velocity']) {
      expect(exemption).toBeLessThan(guard.indexOf(cap));
    }
    // A reservation carries no PaymentIntent. If the exemption stopped testing for that,
    // `payment_intent_id = null` would still be false — but only by accident, and an
    // `is not distinct from` rewrite would exempt every reservation from every cap.
    expect(guard).toMatch(/new\.payment_intent_id is not null and exists/);
  });

  it('the caps are serialised, so concurrent tips cannot all read an empty ledger', () => {
    expect(guard).toMatch(/pg_advisory_xact_lock/);
    const firstLock = guard.indexOf('pg_advisory_xact_lock');
    expect(firstLock).toBeLessThan(guard.indexOf('into v_existing_cents'));
    expect(firstLock).toBeLessThan(guard.indexOf('into v_captured_cents'));

    // Poster lock before booking lock, always — two concurrent tips grabbing them in
    // opposite orders is a deadlock.
    const posterLock = guard.indexOf('gohustlr.tip.poster:');
    const bookingLock = guard.indexOf('gohustlr.tip.booking:');
    expect(posterLock).toBeGreaterThan(-1);
    expect(bookingLock).toBeGreaterThan(posterLock);

    // ...and the replay exemption must still come first, so a retry never blocks on a
    // lock it doesn't need.
    expect(guard.indexOf('where payment_intent_id = new.payment_intent_id')).toBeLessThan(firstLock);
  });

  it('an expired reservation stops consuming headroom, in both cap queries', () => {
    // This is the whole answer to "what if the function dies between reserve and
    // confirm". It has to hold for the per-booking sums AND the poster velocity sum, or
    // one stranded reservation locks a poster out of tipping for 24 hours.
    const occurrences = (s) => s.split(LIVE_SLOT).length - 1;
    expect(occurrences(guard)).toBeGreaterThanOrEqual(2);
    expect(occurrences(helper)).toBeGreaterThanOrEqual(2);
    // And it must never be expressed as housekeeping — a sweep that stops running would
    // silently turn every stranded reservation into a permanent cap.
    expect(guard).not.toMatch(/delete from public\.tip_ledger/);
  });

  it('the guard and the headroom helper agree on the limits', () => {
    // Two copies of the same arithmetic; a drift means the pre-check admits something
    // the trigger then rejects — i.e. exactly the charged-but-uncredited case.
    for (const literal of ['20000', '50000', '>= 3', LIVE_SLOT]) {
      expect(guard).toContain(literal);
      expect(helper).toContain(literal);
    }
  });

  it('nothing else restates the cap arithmetic', () => {
    // The point of reserving through the trigger is that there is ONE definition. A copy
    // in reserve_tip_slot would be the same bug in a new place: two limits, drifting.
    for (const literal of ['20000', '50000', '>= 3']) {
      expect(reserve).not.toContain(literal);
    }
    // It refuses by catching the trigger's own verdict, and only that verdict.
    expect(reserve).toMatch(/when check_violation then/);
    expect(reserve).toMatch(/not like 'tip_cap_%'/);
    expect(reserve).toMatch(/raise;/);
  });

  it('headroom helper is not reachable by clients', () => {
    // Exposing it to `authenticated` turns it into a probe for other people's tip
    // history via a guessed booking id.
    expect(migration).toMatch(/revoke execute on function public\.tip_headroom_cents\(uuid\) from public, anon, authenticated/);
    expect(migration).toMatch(/grant execute on function public\.tip_headroom_cents\(uuid\) to service_role/);
  });

  it('every new tip RPC is service-role only', () => {
    for (const sig of [
      'reserve_tip_slot(uuid, integer)',
      'confirm_tip_charge(text, text)',
      'release_tip_reservation(text)',
      'record_tip_reversal(text, integer, text)',
    ]) {
      const esc = sig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(migration).toMatch(new RegExp(`revoke execute on function public\\.${esc} from public, anon, authenticated`));
      expect(migration).toMatch(new RegExp(`grant execute on function public\\.${esc} to service_role`));
    }
  });
});

describe('confirm and release cannot damage a real tip', () => {
  it('confirm claims the credit exactly once', () => {
    expect(confirm).toMatch(/credited\s+= true/);
    expect(confirm).toMatch(/and coalesce\(credited, false\) = false/);
    expect(confirm).toMatch(/returning true into v_claimed/);
    // It must look up the PaymentIntent first: confirm releases the reservation key, so
    // after a successful pass the PI is the only handle a retry can arrive with.
    expect(confirm.indexOf('where payment_intent_id = p_pi'))
      .toBeLessThan(confirm.indexOf('where reservation_key = p_key'));
  });

  it('release only ever removes an uncharged reservation', () => {
    expect(release).toMatch(/delete from public\.tip_ledger/);
    expect(release).toMatch(/payment_intent_id is null/);
    expect(release).toMatch(/coalesce\(credited, false\) = false/);
  });

  it('a row is either a charge or a reservation, never neither', () => {
    expect(migration).toMatch(/check \(payment_intent_id is not null or reserved_until is not null\)/);
    // The reservation key is unique, which IS the double-tap collapse: two taps race for
    // one row and the loser charges under the winner's Stripe idempotency key.
    expect(migration).toMatch(/create unique index if not exists tip_ledger_reservation_key_uidx/);
  });

  it('a stale reservation is retired for a human, not deleted', () => {
    // It is the one shape where money may have moved without being recorded, so the row
    // survives and ctl_earner_credit_missing names it apart from a real charged tip.
    //
    // Retired by RENAMING, never by nulling. A nulled key is unaddressable forever —
    // release_tip_reservation matches `reservation_key = p_key` and null equals nothing,
    // while confirm_tip_charge would find the NEW row under that key. The corpse would sit
    // uncredited and unclearable, and an operator following the printed remedy with the
    // reconstructed key would release the LIVE reservation instead, handing headroom back
    // mid-charge. This assertion previously pinned the nulling version, i.e. the bug.
    expect(reserve).toMatch(/set reservation_key = v_key \|\| '_retired_' \|\| id::text/);
    expect(reserve).not.toMatch(/set reservation_key = null/);
    expect(staleTip).toContain('tip_reservation_unconfirmed');
    expect(staleTip).toContain('tip_charged_not_credited');
    expect(staleTip).toContain('stripe_idempotency_key');
    // The old remedy told the operator to credit the earner outright, which on a
    // reservation would pay out a card that may never have been charged.
    expect(staleTip).toContain('release_tip_reservation');
  });
});

describe('a reversed tip is recorded, and the drift control can see it', () => {
  it('tip_ledger carries the reversal columns', () => {
    expect(migration).toMatch(/add column if not exists reversed_cents/);
    expect(migration).toMatch(/add column if not exists earner_reversed_cents/);
    expect(migration).toMatch(/add column if not exists reversed_at/);
  });

  it('record_tip_reversal has the signature stripe-webhook will call', () => {
    expect(migration).toMatch(
      /create or replace function public\.record_tip_reversal\(\s*p_payment_intent text,\s*p_target_cents\s+integer,\s*p_reason\s+text\s*\) returns integer/,
    );
  });

  it('redelivery is a no-op BY CONSTRUCTION, not by a second check', () => {
    // Stripe hands out running totals, so the same event redelivered carries the same
    // number and the delta is zero. An idempotency check bolted alongside is a thing that
    // can be dropped in a rewrite; arithmetic that cannot double-apply is not.
    expect(reversal).toMatch(/v_target := least\(greatest\(coalesce\(p_target_cents, 0\), 0\), coalesce\(v_amount, 0\)\)/);
    expect(reversal).toMatch(/v_delta := v_target - v_reversed/);
    expect(reversal).toMatch(/if v_delta <= 0 then\s*return 0;/);
    expect(reversal).toMatch(/set reversed_cents\s+= v_target/);
  });

  it('an unknown PaymentIntent answers NULL, not 0', () => {
    // The caller has to tell "this is not a tip" from "already reversed to that figure",
    // or the webhook's fallback silently swallows every reversal it cannot attribute.
    const lookup = reversal.indexOf('where payment_intent_id = p_payment_intent');
    const nullReturn = reversal.indexOf('return null;', lookup);
    expect(lookup).toBeGreaterThan(-1);
    expect(nullReturn).toBeGreaterThan(lookup);
    expect(nullReturn).toBeLessThan(reversal.indexOf('v_target :='));
  });

  it('a chargeback does not debit the earner, and the branch matches what the webhook writes', () => {
    // 20260813160000: on a destination charge Stripe debits the PLATFORM balance and does
    // not reverse the transfer, so the money is already with the earner and stays there.
    // Debiting them would be a cosmetic decrement that makes a number wrong.
    const branch = reversal.match(/not ilike '([^']+)'/);
    expect(branch).not.toBeNull();

    const reasons = [...webhookRaw.matchAll(/`(Stripe [^`]*)`/g)]
      .map((m) => m[1].replace(/\$\{[^}]*\}/g, 'X'));
    const chargeback = reasons.find((r) => /chargeback/i.test(r));
    const refund = reasons.find((r) => /refund/i.test(r));
    expect(chargeback).toBeDefined();
    expect(refund).toBeDefined();

    const ilike = new RegExp(
      `^${branch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`,
      'i',
    );
    expect(ilike.test(chargeback)).toBe(true);
    expect(ilike.test(refund)).toBe(false);

    // And what was ACTUALLY taken is recorded, never left to be re-derived later — the
    // whole lesson of 20260814050000.
    expect(reversal).toMatch(/earner_reversed_cents = coalesce\(earner_reversed_cents, 0\)/);
    expect(reversal).toMatch(/case when v_debit and v_credited then v_delta else 0 end/);
  });

  it('ctl_earnings_total_drift subtracts the reversed tips', () => {
    expect(driftSrc.file).toBe(NEW_MIGRATION);
    // Without this CTE, every correctly handled reversal becomes a permanent unresolvable
    // HIGH finding — and before there was any reversal writer, a fully reversed tip left
    // stored == expected exactly and this control certified the inflated balance.
    expect(drift).toMatch(/tip_clawed as \(/);
    expect(drift).toMatch(/sum\(coalesce\(t\.earner_reversed_cents, 0\)\)/);
    expect(drift.replace(/\s+/g, ' ')).toContain('- coalesce(r.cents, 0) - coalesce(tr.cents, 0)');
    expect(drift).toContain("'tip_clawback_cents'");
    // The escrow half must survive the rewrite untouched.
    expect(drift).toMatch(/sum\(coalesce\(p\.earner_refunded_cents, 0\)\)/);
  });
});

describe('the migration proves itself', () => {
  it('ends in a discriminating probe that rolls back', () => {
    expect(migration).toContain("raise exception 'probe complete — rolling back'");
    // Both findings, on the same staged rows: the read gate consumed nothing, and the
    // old control body called a fully reversed tip healthy.
    expect(migrationRaw).toContain('a read consumes nothing');
    expect(migrationRaw).toContain('the old body would not have called this healthy');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ctl_earner_credit_missing is a UNION of two unrelated shapes, and only the TIP half
// was ever meant to change. A redefinition that kept just the tip arm dropped the escrow
// arm — "money captured from a poster and never credited to the earner" — and that is
// not merely going blind: run_control auto-resolves anything a control stops returning,
// scoped only by control_key, so the first sweep would have silently closed every open
// finding of that kind on real unremediated captures.
//
// Nothing else can see them. ctl_payment_ledger_impossible tests the opposite direction
// (credited_without_capture), and ctl_earnings_total_drift's `credited` CTE filters on
// earnings_credited, so an uncredited capture is absent from both stored and expected and
// nets to zero drift.
//
// Caught in review before it was applied. This is why the arm is asserted rather than
// trusted.
// ─────────────────────────────────────────────────────────────────────────────
describe('ctl_earner_credit_missing keeps BOTH arms', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const MIG2 = path2.join(__dirname, '..', 'supabase', 'migrations');

  const latest = fs2
    .readdirSync(MIG2)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) =>
      /create or replace function public\.ctl_earner_credit_missing/i.test(
        fs2.readFileSync(path2.join(MIG2, f), 'utf8'),
      ),
    )
    .pop();

  const sql = fs2.readFileSync(path2.join(MIG2, latest), 'utf8');
  const body = sql.slice(
    sql.search(/create or replace function public\.ctl_earner_credit_missing/i),
    sql.search(/revoke execute on function public\.ctl_earner_credit_missing/i),
  );

  it('found the live definition', () => {
    expect(latest).toBeDefined();
    expect(body.length).toBeGreaterThan(200);
  });

  it('still reports captures that were never credited', () => {
    expect(`${latest}: ${/escrow_capture_not_credited/.test(body)}`).toBe(`${latest}: true`);
    // The predicate, not just the label — a kind string with no query behind it is worse.
    expect(body).toMatch(/from public\.payments p/i);
    expect(body).toMatch(/coalesce\(p\.earnings_credited, false\) = false/i);
  });

  it('still reports tips that were charged and never credited', () => {
    expect(`${latest}: ${/tip_charged_not_credited/.test(body)}`).toBe(`${latest}: true`);
    expect(body).toMatch(/from public\.tip_ledger t/i);
  });

  it('unions them rather than replacing one with the other', () => {
    expect(body).toMatch(/union all/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The reversal RPC needs a CALLER, or the whole thing is decoration.
//
// record_tip_reversal, tip_ledger.reversed_cents and the drift control's tip clawback all
// shipped together and were, for a moment, completely inert: recordReversal returns early
// when the payments lookup misses, and a tip has no payments row by construction — so
// every refunded or charged-back tip still fell out before reaching any of it.
//
// That is the same shape as the two defects this repo has already paid for: a correct
// handler wired to nothing (the payout events), and a throttle in SQL with zero callers
// (the admin login). Both reported success because nothing was delivered to fail.
// ─────────────────────────────────────────────────────────────────────────────
describe('a refunded tip actually reaches the reversal', () => {
  const fs3 = require('fs');
  const path3 = require('path');
  const webhookSrc = fs3.readFileSync(
    path3.join(__dirname, '..', 'supabase', 'functions', 'stripe-webhook', 'index.ts'),
    'utf8',
  );
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const code = stripComments(webhookSrc);

  it('recordReversal falls back to tip_ledger when there is no payments row', () => {
    // Without this the RPC has no caller at all.
    expect(code).toMatch(/from\(['"]tip_ledger['"]\)/);
    expect(code).toMatch(/rpc\(\s*['"]record_tip_reversal['"]/);
  });

  it('the fallback runs BEFORE the no-booking early return', () => {
    const fn = code.slice(code.indexOf('async function recordReversal'));
    const fallback = fn.indexOf("from('tip_ledger')") >= 0
      ? fn.indexOf("from('tip_ledger')")
      : fn.indexOf('from("tip_ledger")');
    const bail = fn.indexOf('if (!bookingId) return null;');
    expect(fallback).toBeGreaterThan(-1);
    expect(bail).toBeGreaterThan(-1);
    // A fallback after the bail would never execute — the exact bug being guarded.
    expect(fallback).toBeLessThan(bail);
  });

  it('a chargeback reverses the whole tip, a refund only Stripe\'s cumulative figure', () => {
    // A chargeback moves no refund figure, so passing stripeRefundedCents (null) as the
    // target would reverse nothing and silently leave the earner credited.
    const fn = code.slice(code.indexOf('async function recordReversal'));
    const call = fn.slice(fn.indexOf('record_tip_reversal'), fn.indexOf('record_tip_reversal') + 400);
    expect(call).toMatch(/p_target_cents:\s*kind === ['"]chargeback['"]/);
    expect(call).toMatch(/stripeRefundedCents/);
  });

  it('a failed reversal is paged, not swallowed', () => {
    // Money has left the platform balance and the earner still holds the credit; nothing
    // downstream reconciles a tip on its own.
    const fn = code.slice(code.indexOf('async function recordReversal'));
    const after = fn.slice(fn.indexOf('record_tip_reversal'));
    expect(after.slice(0, 700)).toMatch(/logServerError/);
    expect(after.slice(0, 700)).toMatch(/fatal:\s*true/);
  });
});
