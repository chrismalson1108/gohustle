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
    const re = new RegExp(`create or replace function public\\.${fnName}\\s*\\(([\\s\\S]*?)\\n\\$\\$;`, 'g');
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

  it('never writes pct_paid — that column means "what was actually collected"', () => {
    // The old row carried the reduced percentage in pct_paid, which is why the console
    // rendered a proposal as a settlement: the two were the same act.
    expect(partial).not.toMatch(/pct_paid:/);
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
    expect(partial).toMatch(/from\('disputes'\)\.select\('id, settle_after'\)\.eq\('booking_id'/);
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

  it('web reaches it from My Jobs', () => {
    expect(codeOnly(read('web/app/(app)/my-jobs/page.tsx'))).toMatch(/\/my-jobs\/dispute\//);
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
