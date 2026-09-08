const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// A reported problem has two parties, and the money waits for both of them.
//
// Before 2026-09-09 a poster's "there was a problem" tap did all of this inside one
// request: capture the reduced amount, credit the earner, flip the booking to verified,
// and — about eighty lines later — insert a `disputes` row describing what had just
// happened. The accused party had no screen, no notice they could rely on, and no way to
// answer; and because a partial capture releases the remainder to the poster and
// `stripe.transfers.create` appears nowhere in this repo, no reply could have changed
// anything afterwards.
//
// The fix is a shape, not a feature, and every part of the shape is load-bearing:
//
//   the tap proposes           →  the authorization stays live
//   the server notifies        →  not a fire-and-forget push from the accuser's phone
//   the earner answers         →  on both clients, with photos
//   a clock or a human decides →  in ONE place, in SQL
//   the sweep captures         →  and stamps what was actually collected
//
// Each assertion below is a way that shape has to break silently: a settlement that
// re-appears in the poster's request, a percentage re-decided in TypeScript, a console
// that closes a case while the escrow is still held, a client that can read the
// accusation and not answer it.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
// Comments describe intent; only code enforces it. Every check below runs on code.
const codeOnly = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*--.*$/gm, '');

// The LAST migration that defines each function — resolved, never named. A guard that
// opens a migration by filename asserts against a body a later `create or replace` has
// already replaced (pricing.test.js was doing exactly that until 2026-09-06).
const MIGRATIONS = path.join(ROOT, 'supabase/migrations');
function liveBody(fnName) {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  let body = null;
  for (const f of files) {
    const src = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    // ⚠️ BOTH dollar-quote spellings. This matched only `$$;` until 2026-09-08, so a
    // function redefined with the `$function$` delimiter — which is what `pg_get_functiondef`
    // emits, and therefore what anyone copying a live body writes — was invisible here and
    // the helper silently returned an OLDER definition. A drift guard that reads the wrong
    // body is worse than none: it passes while asserting against history.
    const re = new RegExp(
      `create or replace function public\\.${fnName}\\s*\\(([\\s\\S]*?)\\n\\$(?:function)?\\$;`,
      'g',
    );
    const hits = [...src.matchAll(re)];
    if (hits.length) body = hits[hits.length - 1][0];
  }
  return body;
}

describe('the poster proposes — the poster does not settle', () => {
  const capture = codeOnly(read('supabase/functions/stripe-capture-payment/index.ts'));
  // Everything specific to a reduction lives between the branch and its return.
  const partial = capture.slice(capture.indexOf('if (wantsPartial)'), capture.indexOf('Full pay') === -1
    ? capture.length
    : capture.indexOf("adjustment: 'proposed', settleAfter: created.settle_after"));

  it('records a proposal rather than a payment', () => {
    expect(partial).toMatch(/from\('disputes'\)\.insert\(/);
    expect(partial).toMatch(/proposed_pct:/);
  });

  // The no-runway escape is a SETTLEMENT, not a proposal — it captures in full because
  // the card hold is about to die — so it legitimately stamps pct_paid. Split it off
  // rather than loosening the rule that matters.
  const noRunway = partial.slice(
    partial.indexOf('if (runwayHours < MIN_RUNWAY_HOURS)'),
    partial.indexOf('Idempotent per booking') === -1 ? partial.length : partial.indexOf('Idempotent per booking'),
  );
  const proposalOnly = partial.replace(noRunway, '');

  it('never writes pct_paid on the proposal path — that column means "what was actually collected"', () => {
    // The old row carried the reduced percentage in pct_paid, which is why the console
    // rendered a proposal as a settlement: the two were the same act.
    expect(proposalOnly).not.toMatch(/pct_paid:/);
  });

  it('the no-runway capture files the evidence instead of discarding it', () => {
    // This branch returned before the insert was reachable, so a poster's reason and up
    // to six photos vanished on exactly the path where a refund is most likely to be
    // asked for and there was nothing to review it against.
    expect(noRunway).toMatch(/from\('disputes'\)\.insert\(/);
    expect(noRunway).toMatch(/reason:/);
    expect(noRunway).toMatch(/photos: photosNow/);
    expect(noRunway).toMatch(/pct_paid: 100/);
    expect(noRunway).toMatch(/resolution_note:/);
  });

  it('the hold is aged from authorized_at, not from the first hold ever placed', () => {
    // created_at is the first authorization on the booking and a recovery re-hold
    // leaves it alone (20260806150000). Three sites in this repo have got this wrong.
    expect(partial).toMatch(/payRow\.authorized_at \?\? payRow\.created_at/);
    expect(partial).toMatch(/authorized_at, amount_cents|authorized_at/);
  });

  it('captures nothing on a reduction, and only ever in full on the no-runway path', () => {
    const pcts = [...partial.matchAll(/capturePct:\s*([^,\n]+)/g)].map((m) => m[1].trim());
    expect(pcts.length).toBeGreaterThan(0);
    // A single settleEscrow call, and it is the deliberate NO_ROOM_TO_HOLD escape:
    // a hold about to lapse pays nobody, which is strictly worse for the earner than
    // any outcome the dispute could reach, and full capture is the one direction
    // admin-payment-action can walk back.
    expect(pcts.every((p) => p === '1')).toBe(true);
    expect(partial).toMatch(/NO_ROOM_TO_HOLD/);
  });

  it('leaves the booking un-verified, so the escrow is still the remedy', () => {
    expect(partial).not.toMatch(/status:\s*'verified'/);
  });

  it('checks the insert — a failed write used to leave no trace anywhere', () => {
    expect(partial).toMatch(/if \(dErr \|\| !created\)/);
    expect(partial).toMatch(/logServerError\(/);
  });

  it('is idempotent per booking, and does not restart the earner’s clock', () => {
    // The SELECT is the fast path. It used to be the WHOLE guard — read-then-decide,
    // which two taps on "report a problem" beat, giving the earner two clocks and two
    // percentages for one gig and letting settle-disputes stamp the second row with
    // whatever the first collected. A UNIQUE INDEX is the guard now; see below.
    expect(partial).toMatch(/from\('disputes'\)\.select\('id, settle_after, proposed_pct'\)[\s\S]{0,140}\.eq\('booking_id', bookingId\)/);
  });

  it('scopes that read to a LIVE proposal, because a booking can hold other dispute rows', () => {
    // NO_ROOM_TO_HOLD files a pre-settled row and recordReversal files a bare
    // refund/chargeback row. Unscoped, `.maybeSingle()` returns {data:null, error} the
    // moment there are two of anything — and only `data` was read, so the guard fell
    // through and inserted another.
    expect(partial).toMatch(/\.is\('pct_paid', null\)/);
    expect(partial).toMatch(/\.not\('proposed_pct', 'is', null\)/);
  });

  it('treats the unique violation as "already proposed", not as "nothing was recorded"', () => {
    // Losing the insert race means the proposal DID land and the earner IS on the
    // clock. Reporting the 500 would make the poster report it a second time.
    expect(partial).toMatch(/dErr\?\.code === '23505'/);
  });

  it('a migration actually creates that index, partial on exactly a live proposal', () => {
    const idx = fs.readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql')).sort()
      .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
      .find((s) => /disputes_one_live_proposal_per_booking/.test(s));
    expect(`an index migration exists: ${Boolean(idx)}`).toBe('an index migration exists: true');
    expect(idx).toMatch(/create unique index[\s\S]*?on public\.disputes \(booking_id\)/i);
    // Settled rows and reversal records must stay outside it or this breaks
    // NO_ROOM_TO_HOLD and stripe-webhook.
    expect(idx).toMatch(/where pct_paid is null and proposed_pct is not null/i);
  });

  it('accepts only photo paths under the caller’s own folder', () => {
    expect(partial).toMatch(/startsWith\(`\$\{user\.id\}\/`\)/);
  });
});

describe('the rule that decides the outcome lives in one place', () => {
  const fn = liveBody('dispute_settlement_pct');

  it('exists', () => expect(fn).toBeTruthy());

  it('carries all four branches', () => {
    const body = codeOnly(fn);
    expect(body).toMatch(/d\.resolution_pct is not null/);          // 1. a human decided
    expect(body).toMatch(/d\.response_stance = 'accept'/);           // 2. the earner agreed
    expect(body).toMatch(/d\.responded_at is null/);                 // 3. silence stands
    expect(body).toMatch(/d\.response_stance = 'contest'/);          // 4. the hold is running out
    expect(body).toMatch(/return 100;/);
  });

  it('is service-role only — an outcome an earner could call is an outcome they can shop', () => {
    const src = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))
      .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')).join('\n');
    expect(src).toMatch(/revoke execute on function public\.dispute_settlement_pct\(public\.disputes\) from public, anon, authenticated;/);
  });

  it('the settler asks it rather than re-deciding in TypeScript', () => {
    const settler = codeOnly(read('supabase/functions/settle-disputes/index.ts'));
    expect(settler).toMatch(/rpc\('dispute_due_pct'/);
    // No second copy of the branches. A settler that tested the stance itself would
    // drift from the SQL the console and the controls both read.
    expect(settler).not.toMatch(/response_stance ===/);
    expect(settler).not.toMatch(/settle_after\s*[<>]/);
  });

  it('the settler stamps only a row nobody else has settled', () => {
    const settler = codeOnly(read('supabase/functions/settle-disputes/index.ts'));
    expect(settler).toMatch(/\.is\('pct_paid', null\)/);
    expect(settler).toMatch(/pct_paid: paidPct/);
  });
});

describe('the accused party is told, and has a window', () => {
  it('48 hours, stamped by the database at insert', () => {
    const fn = codeOnly(liveBody('dispute_set_defaults') || '');
    expect(fn).toMatch(/interval '48 hours'/);
    expect(fn).toMatch(/new\.respondent_id/);
  });

  it('the notice is written by the server, in the same transaction', () => {
    const fn = codeOnly(liveBody('dispute_notify_respondent') || '');
    expect(fn).toMatch(/insert into public\.notifications/);
    expect(fn).toMatch(/new\.respondent_id/);
  });

  it('nobody but the server can write the settlement columns', () => {
    const fn = codeOnly(liveBody('guard_disputes_write') || '');
    for (const col of ['pct_paid', 'resolution_pct', 'resolved_at', 'proposed_pct', 'settle_after', 'reason', 'photos']) {
      expect(fn).toMatch(new RegExp(`new\\.${col}\\s*:?=\\s*old\\.${col}`));
    }
    // The response columns are writable only from inside respond_to_dispute, and the
    // exemption names THIS row — a bare on/off flag could be set once and used to
    // rewrite a different dispute in the same transaction.
    expect(fn).toMatch(/current_setting\('app\.dispute_response', true\)[^;]*= old\.id::text/);
  });
});

describe('both clients can read the accusation and answer it', () => {
  const surfaces = [
    ['mobile', 'src/screens/DisputeScreen.js'],
    ['web', 'web/app/(app)/my-jobs/dispute/[bookingId]/page.tsx'],
  ];

  surfaces.forEach(([label, file]) => {
    it(`${label}: reads through my_dispute and answers through respond_to_dispute`, () => {
      const src = codeOnly(read(file));
      expect(src).toMatch(/my_dispute/);
      expect(src).toMatch(/respond_to_dispute/);
      // Both stances. An "accept" with no "contest" is a consent form, not a reply.
      expect(src).toMatch(/'accept'|"accept"/);
      expect(src).toMatch(/'contest'|"contest"/);
    });

    it(`${label}: the reply can carry photos`, () => {
      const src = codeOnly(read(file));
      expect(src).toMatch(/uploadPrivateImages/);
      expect(src).toMatch(/completion-photos/);
    });
  });

  it('mobile registers the screen and reaches it from My Jobs', () => {
    const app = codeOnly(read('App.js'));
    expect(app).toMatch(/name="Dispute"/);
    expect(app).toMatch(/DisputeScreen/);
    expect(codeOnly(read('src/screens/EarnScreen.js'))).toMatch(/navigate\('Dispute'/);
  });

  it('web reaches it from the state a dispute is actually in', () => {
    // A substring match is not enough and this is why: the banner shipped inside
    // `confirmed && startedAt && !earnerDone`, a state a dispute can never reach —
    // stripe-capture-payment refuses anything but completed/verified and the proposal
    // branch leaves the booking `completed`. The link existed, the test passed, and the
    // web earner had no door. Assert it renders in the `completed` branch.
    const src = codeOnly(read('web/app/(app)/my-jobs/page.tsx'));
    expect(src).toMatch(/\/my-jobs\/dispute\//);
    const done = src.slice(src.indexOf('b.status === "completed"'));
    expect(done.slice(0, 900)).toMatch(/disputeBanner\(/);
  });

  it('a dispute alert opens the dispute, not the public gig listing', () => {
    // Both routers tested job_id first, and the dispute notice carries one — so the
    // one server-written notice saying "open it to see why and respond" landed on a
    // page with no dispute UI and no clock.
    for (const f of ['src/lib/notifications.js', 'web/lib/notifications.ts']) {
      const src = codeOnly(read(f));
      const fn = src.slice(src.search(/export function notification(Route|Href)/));
      const disputeAt = fn.indexOf('dispute_id');
      const jobAt = fn.indexOf('job_id');
      expect({ file: f, disputeBeforeJob: disputeAt !== -1 && disputeAt < jobAt })
        .toEqual({ file: f, disputeBeforeJob: true });
    }
  });
});

describe('the reason is filtered on the way in, on both clients', () => {
  // It is delivered now, not merely filed: the earner reads it on the dispute screen,
  // in the alerts inbox and in a push, over our signature. The review written beside it
  // in the same sheet has always been filtered.
  [['mobile', 'src/context/JobsContext.js'], ['web', 'web/lib/jobs.tsx']].forEach(([label, file]) => {
    it(`${label}: verifyAndRate runs findProhibited on disputeReason`, () => {
      const src = codeOnly(read(file));
      const verify = src.slice(src.indexOf('verifyAndRate'));
      expect(verify).toMatch(/findProhibited\(disputeReason\)/);
      expect(verify).toMatch(/logModerationBlock\(reasonTerm, ['"]dispute_reason['"]/);
    });
  });

  it('the poster can attach evidence on both clients', () => {
    expect(codeOnly(read('src/components/CompletionModal.js'))).toMatch(/uploadPrivateImages/);
    expect(codeOnly(read('web/components/CompletionModal.tsx'))).toMatch(/uploadPrivateImages/);
  });
});

describe('a client can only select columns the grant actually covers', () => {
  // Column-level grants do NOT extend to a column added later, and PostgREST answers 403
  // for one that is not granted — which passes jest, passes tsc, passes the simulator
  // against a permissive local database, and fails only in production. The grant list is
  // parsed out of the migration rather than retyped here, so this cannot agree with a
  // stale copy of itself.
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  let grant = null;
  for (const f of files) {
    const hits = [...fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')
      .matchAll(/grant select \(([^)]*)\) on public\.disputes to authenticated;/g)];
    if (hits.length) grant = hits[hits.length - 1][1];
  }
  const granted = new Set((grant || '').split(',').map((c) => c.trim()).filter(Boolean));

  it('the grant exists and withholds the staff columns', () => {
    expect(granted.size).toBeGreaterThan(10);
    expect(granted.has('assigned_to')).toBe(false);
    expect(granted.has('resolved_by')).toBe(false);
  });

  [
    'src/screens/EarnScreen.js',
    'src/screens/GigsScreen.js',
    'web/app/(app)/my-jobs/page.tsx',
  ].forEach((file) => {
    it(`${file} selects nothing it cannot read`, () => {
      const src = codeOnly(read(file));
      const sel = src.match(/from\(["']disputes["']\)\s*\n?\s*\.select\(["']([^"']+)["']\)/);
      expect(sel).toBeTruthy();
      const asked = sel[1].split(',').map((c) => c.trim()).filter(Boolean);
      expect(asked.filter((c) => !granted.has(c))).toEqual([]);
    });
  });
});

describe('the console decides — and cannot decide the one direction nobody can undo', () => {
  const actions = codeOnly(read('admin/app/(console)/disputes/actions.ts'));
  const decide = actions.slice(actions.indexOf('export async function decideDispute'));

  it('bounds the decision to [proposed_pct, 100]', () => {
    expect(decide).toMatch(/const floor = d\.proposed_pct \?\? 100;/);
    expect(decide).toMatch(/if \(pct < floor\)/);
    expect(decide).toMatch(/pct > 100/);
  });

  it('steps up, because it decides how much money moves', () => {
    expect(decide).toMatch(/requireFreshAdmin\("trust"\)/);
  });

  it('refuses a dispute that has already settled, by read AND by predicate', () => {
    expect(decide).toMatch(/if \(d\.pct_paid != null\)/);
    expect(decide).toMatch(/\.is\("pct_paid", null\)/);
  });

  it('does not stamp resolved_at — that would hand the earner a 100% self-claim', () => {
    // earner-claim-payment gates on resolved_at and captures in FULL, so writing it
    // before settle-disputes has applied the decision silently overrides the decision.
    expect(decide).not.toMatch(/resolved_at:/);
    expect(decide).toMatch(/resolution_pct: pct/);
  });

  it('closing a case is refused while the escrow is still held', () => {
    const status = actions.slice(0, actions.indexOf('export async function decideDispute'));
    expect(status).toMatch(/pay\?\.status === "authorized"/);
    expect(status).toMatch(/d\.pct_paid == null/);
  });
});

describe('the case file shows both sides and can reach both people', () => {
  const page = codeOnly(read('admin/app/(console)/disputes/[id]/page.tsx'));

  it('renders the accusation and the answer, with the photos of each', () => {
    expect(page).toMatch(/d\.reason/);
    expect(page).toMatch(/d\.response_note/);
    expect(page).toMatch(/sign\(d\.photos\)/);
    expect(page).toMatch(/sign\(d\.response_photos\)/);
  });

  it('shows the completion photos — usually the answer to "that is a different door"', () => {
    expect(page).toMatch(/sign\(booking\?\.completion_photos\)/);
  });

  it('opens a separate conversation with each party', () => {
    // TWO forms, not one thread with both in it: neither party should read what the
    // other told us in confidence.
    expect((page.match(/<OpenThreadForm/g) || []).length).toBe(2);
    expect(page).toMatch(/bookingId=\{d\.booking_id\}/);
  });

  it('is gated at the tier whose queue this is', () => {
    expect(page).toMatch(/requireAdminPage\("trust"\)/);
    expect(page).toMatch(/roleSatisfies\(ctx\.role, "trust"\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nothing else may touch a hold that a live adjustment owns.
//
// Both of these were written when the poster's Verify sheet still CAPTURED, so an
// outstanding proposal could not coexist with an open authorization. Under the two-party
// model it is the ordinary state — stripe-capture-payment leaves pct<1 at
// payment='authorized' / booking='completed' — and it is exactly the state the console's
// two hold buttons are offered on, on exactly the page an operator opens because of a
// dispute.
//
//   settle       captures the FULL hold. On a $200 gig where the poster proposed 60% and
//                the earner ACCEPTED, one click charges $200 instead of $120 and pays the
//                earner $186 instead of $111.60 — into a Connect account, which the
//                platform cannot claw back without a separate refund. settle-disputes
//                then stamps pct_paid=100 and tells the poster their report "did not stand".
//   release_hold voids the authorization settle-disputes needs. The dispute never reaches
//                pct_paid, so it returns HOLD_EXPIRED on every sweep for ever, and nothing
//                in this repo can pay that earner afterwards.
//
// Every sibling settlement path already refuses (earner-claim-payment: DISPUTE_OPEN;
// stripe-capture-payment: ALREADY_SETTLED). This was the last one that did not.
// ─────────────────────────────────────────────────────────────────────────────
describe('the operator cannot settle or void a hold a live adjustment owns', () => {
  const apa = codeOnly(read('supabase/functions/admin-payment-action/index.ts'));

  it('checks the disputes table before either hold-touching op', () => {
    expect(apa).toMatch(/if \(op === 'release_hold' \|\| op === 'settle'\)/);
    expect(apa).toMatch(/from\('disputes'\)/);
  });

  it('scopes the check to a LIVE adjustment, not to any dispute row', () => {
    // A settled row (pct_paid) and a reversal record (no proposed_pct) must not block an
    // operator: the first is history and the second is the webhook's own bookkeeping.
    const block = apa.slice(apa.indexOf("op === 'release_hold' || op === 'settle'"));
    expect(block).toMatch(/\.is\('pct_paid', null\)/);
    expect(block).toMatch(/\.not\('proposed_pct', 'is', null\)/);
  });

  it('fails CLOSED when the disputes read errors', () => {
    // An unreadable table is not evidence that there is no dispute, and the action behind
    // it is irreversible in the direction that matters.
    expect(apa).toMatch(/dispute_check_unavailable/);
  });

  it('refuses with a distinct code that names where the decision lives', () => {
    expect(apa).toMatch(/error: 'dispute_open'/);
    expect(apa).toMatch(/\/disputes\/\$\{liveDispute\.id\}/);
  });

  it('the console does not offer a button the guard will refuse', () => {
    const panel = codeOnly(read('admin/app/(console)/bookings/[id]/InterventionPanel.tsx'));
    const page = codeOnly(read('admin/app/(console)/bookings/[id]/page.tsx'));
    expect(page).toMatch(/openDispute=\{/);
    expect(page).toMatch(/pct_paid === null && d\.proposed_pct !== null/);
    // Both hold buttons, not just settle.
    const gated = panel.match(/disabled=\{pending \|\| paymentStatus !== "authorized" \|\| Boolean\(openDispute\)\}/g) || [];
    expect(`hold buttons gated on openDispute: ${gated.length}`).toBe('hold buttons gated on openDispute: 2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One poisoned dispute must not starve every other settlement.
// ─────────────────────────────────────────────────────────────────────────────
describe('settle-disputes isolates one dispute from the next', () => {
  const sd = codeOnly(read('supabase/functions/settle-disputes/index.ts'));

  it('wraps the per-dispute body in its own try/catch and continues', () => {
    // settleEscrow returns {ok:false} for every failure it MODELS, but the two
    // stripe.paymentIntents.capture calls throw. A throw used to unwind past the loop to
    // the single outer catch, aborting the batch — deterministically, every hour, for
    // ever, because the listing is oldest-first and the poisoned row sorts first.
    const loop = sd.slice(sd.indexOf('for (const d of rows ?? [])'), sd.indexOf('return json({ ok: true, settled:'));
    expect(loop).toMatch(/\btry\s*\{/);
    expect(loop).toMatch(/\}\s*catch\s*\(e\)\s*\{/);
    expect(loop).toMatch(/failed\.push\(d\.id\)/);
    expect(loop).toMatch(/continue;/);
  });

  it('the per-dispute failure carries the ids the outer catch cannot', () => {
    // The outer catch logs with an EMPTY context, so /errors named neither the dispute
    // nor the booking that stopped the batch.
    expect(sd).toMatch(/settlement threw for dispute[\s\S]{0,400}dispute_id: d\.id, booking_id: d\.booking_id[\s\S]{0,60}fatal: true/);
  });

  it('still reports failures rather than swallowing them into a success', () => {
    expect(sd).toMatch(/failed: failed\.length/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A dispute row may not claim money moved until it has.
//
// NO_ROOM_TO_HOLD is entered only when the hold is inside its last 36 hours, which is
// exactly when settleEscrow is most likely to refuse — HOLD_EXPIRED on a payment the
// webhook already marked cancelled, EARNER_PAYOUTS_DISABLED on a Connect account Stripe
// restricted in the meantime. The row used to be stamped `pct_paid: 100, settled_at,
// resolved_at, status:'rejected'` BEFORE that call, so a refused capture left a record
// permanently asserting the earner was paid in full while zero cents had moved — and it
// BLINDED the critical control, because dispute_settlement_pct opens with
// `if d.pct_paid is not null then return null` and ctl_dispute_settlement_overdue reads
// through it.
// ─────────────────────────────────────────────────────────────────────────────
describe('the no-runway record is evidence first and a settlement second', () => {
  const capture = codeOnly(read('supabase/functions/stripe-capture-payment/index.ts'));
  const noRunway = capture.slice(
    capture.indexOf('if (runwayHours < MIN_RUNWAY_HOURS)'),
    capture.indexOf('Idempotent per booking') === -1 ? capture.length : capture.indexOf('Idempotent per booking'),
  );
  const insertBlock = noRunway.slice(noRunway.indexOf("from('disputes').insert("), noRunway.indexOf('settleEscrow'));

  it('inserts the poster’s evidence, so a refused capture still leaves a case file', () => {
    expect(insertBlock).toMatch(/reason:/);
    expect(insertBlock).toMatch(/photos: photosNow/);
  });

  it('does NOT pre-stamp the settlement columns', () => {
    ['pct_paid', 'settled_at', 'resolved_at', 'resolution_note'].forEach((col) => {
      expect(`insert writes ${col}: ${new RegExp(`${col}:`).test(insertBlock)}`)
        .toBe(`insert writes ${col}: false`);
    });
  });

  it('does NOT pre-set proposed_pct, which would arm a clock and notify the earner', () => {
    // dispute_set_defaults derives settle_after from proposed_pct and
    // dispute_notify_respondent fires AFTER INSERT — so setting it here tells the earner
    // they have until X to answer a reduction this branch is about to abandon.
    expect(`insert writes proposed_pct: ${/proposed_pct:/.test(insertBlock)}`)
      .toBe('insert writes proposed_pct: false');
  });

  it('stamps the settlement only after settleEscrow reports ok', () => {
    const afterSettle = noRunway.slice(noRunway.indexOf('const settled = await settleEscrow'));
    expect(afterSettle).toMatch(/if \(!settled\.ok\)[\s\S]{0,400}return json\(/);
    const stamp = afterSettle.slice(afterSettle.indexOf('if (noRoomRow)'));
    expect(stamp).toMatch(/pct_paid: 100/);
    expect(stamp).toMatch(/proposed_pct:/);
    expect(stamp).toMatch(/resolution_note:/);
    // Conditional on still being unsettled, so a racing settler cannot be overwritten.
    expect(stamp).toMatch(/\.is\('pct_paid', null\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A retry is not a revision, and no client may narrate a percentage the row does not
// hold.
//
// The short-circuit returned a bare success, so both clients printed the number the
// POSTER HAD JUST TYPED while the stored row kept the first one and the earner had been
// notified of THAT. Reopening the sheet is one tap on the website — /hiring re-offers
// "Verify & rate" on any `completed` booking with no dispute lookup, and a proposal
// deliberately leaves the booking `completed`.
// ─────────────────────────────────────────────────────────────────────────────
describe('the proposed percentage the poster is told is the one on the record', () => {
  const capture = codeOnly(read('supabase/functions/stripe-capture-payment/index.ts'));

  it('the server returns the RECORDED figure on both the first proposal and a retry', () => {
    const hits = [...capture.matchAll(/adjustment: 'proposed'/g)];
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // Every "proposed" response carries proposedPct.
    hits.forEach((h) => {
      const near = capture.slice(h.index - 200, h.index + 300);
      expect(`response at ${h.index} carries proposedPct: ${/proposedPct/.test(near)}`)
        .toBe(`response at ${h.index} carries proposedPct: true`);
    });
  });

  it('a DIFFERENT percentage is refused rather than silently ignored', () => {
    expect(capture).toMatch(/ADJUSTMENT_ALREADY_PROPOSED/);
    expect(capture).toMatch(/storedPct !== askedPct/);
  });

  it.each([
    ['mobile', 'src/context/JobsContext.js'],
    ['web', 'web/lib/jobs.tsx'],
  ])('%s renders the server’s figure and its real deadline, not a flat 48 hours', (_who, file) => {
    const src = codeOnly(read(file));
    const toast = src.slice(src.indexOf("'Sent to the worker'") === -1
      ? src.indexOf('"Sent to the worker"') - 900
      : src.indexOf("'Sent to the worker'") - 900,
      (src.indexOf("'Sent to the worker'") === -1
        ? src.indexOf('"Sent to the worker"')
        : src.indexOf("'Sent to the worker'")) + 700);
    expect(toast).toMatch(/capture\??\.?\.?proposedPct|capture!\.proposedPct/);
    expect(toast).toMatch(/settleAfter/);
    // The window is derived (least(now+48h, hold_dies-12h), floored at an hour), so a
    // hardcoded 48 is wrong on exactly the bookings with least runway.
    expect(`${_who} hardcodes 48 hours: ${/48 hours to reply/.test(toast)}`)
      .toBe(`${_who} hardcodes 48 hours: false`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Silence has to actually stand, and a payment RECORD is not an adjustment.
//
// Two holes, both found by driving respond_to_dispute against production on 2026-09-08.
//
// 1. A refund/chargeback record — the bare row stripe-webhook's recordReversal files,
//    with no proposed_pct and no clock — was ANSWERABLE. The earner accepts it, branch 2
//    reads `coalesce(d.proposed_pct, 100)` and returns ONE HUNDRED, and settle-disputes
//    stamps pct_paid and resolved_at. The earner has just closed the row whose entire job
//    was to block earner-claim-payment while the reversal is unexplained. Measured: due
//    pct went NULL -> 100. 20260909040000 guarded branch 3 against exactly this shape;
//    branch 2 never got the guard.
//
// 2. CLAUDE.md says "the earner said nothing past settle_after -> proposed_pct (SILENCE
//    STANDS)". It did not. settle-disputes runs hourly, so between settle_after passing
//    and the sweep firing there is up to 59 minutes in which the row is already DUE and
//    nothing has captured it. Measured: window closed with due_pct 60, the earner
//    contested inside the gap, due_pct became NULL. That is a strategy, not a tie — wait
//    out the clock, then contest, and branch 4 pays 100% five days later.
// ─────────────────────────────────────────────────────────────────────────────
describe('a reply cannot retract a settlement the clock already decided', () => {
  const rpc = liveBody('respond_to_dispute');
  const settle = liveBody('dispute_settlement_pct');

  it('both functions are resolvable', () => {
    expect(rpc).toBeTruthy();
    expect(settle).toBeTruthy();
  });

  it('respond_to_dispute refuses a row that carries no proposal', () => {
    expect(codeOnly(rpc)).toMatch(/if d\.proposed_pct is null then\s*\n\s*raise exception/);
  });

  it('respond_to_dispute refuses a reply after the window closed', () => {
    const code = codeOnly(rpc);
    expect(code).toMatch(/d\.settle_after is not null and now\(\) >= d\.settle_after/);
    // And it must be a REFUSAL, not a silent pin.
    const branch = code.slice(code.indexOf('d.settle_after is not null and now()'));
    expect(branch.slice(0, 400)).toMatch(/raise exception/);
  });

  it('the refusal names the percentage on the correct side of the sign', () => {
    // `%%%` in a raise parses as literal-percent then placeholder, which rendered
    // "paid at %60". Built by concatenation so a format parser cannot reorder it.
    expect(codeOnly(rpc)).not.toMatch(/paid at %%%/);
    expect(codeOnly(rpc)).toMatch(/proposed_pct, 100\)::text \|\| '%/);
  });

  it('dispute_settlement_pct refuses to price a row with no proposal', () => {
    const code = codeOnly(settle);
    const guardAt = code.indexOf('d.proposed_pct is null then return null');
    const branch2At = code.indexOf("d.response_stance = 'accept'");
    expect(`the no-proposal guard exists: ${guardAt > -1}`).toBe('the no-proposal guard exists: true');
    // It must come BEFORE branch 2, or branch 2's coalesce still invents a 100.
    expect(`guard precedes branch 2: ${guardAt < branch2At}`).toBe('guard precedes branch 2: true');
  });

  it('branch 2 no longer coalesces a missing proposal to 100', () => {
    const code = codeOnly(settle);
    const b2 = code.slice(code.indexOf("d.response_stance = 'accept'"), code.indexOf('responded_at is null'));
    expect(`branch 2 still coalesces to 100: ${/coalesce\(d\.proposed_pct, 100\)/.test(b2)}`)
      .toBe('branch 2 still coalesces to 100: false');
  });
});
