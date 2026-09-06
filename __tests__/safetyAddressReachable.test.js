// ─────────────────────────────────────────────────────────────────────────────
// The one thing a safety escalation exists to deliver is WHERE THE PERSON IS, and
// until 2026-09-05 nothing on the safety path carried it.
//
// jobs.location is masked at write by trg_mask_job_location — "742 Evergreen Terrace,
// Springfield, IL" is stored as "Springfield, IL" — and the precise label lives in
// public.job_locations, which grants all to service_role. Three surfaces held that key
// or that privilege and none of them used it:
//
//   safety-alert       selected id/reason/details/ids/created_at and emailed names plus
//                      a /moderation link. An earner tapping "Get help" from a
//                      stranger's house paged a human who could not say where they were.
//   ctl_safety_checkin_overdue  built its detail from j.location — the masked column.
//   the admin console  `grep -rn job_locations admin/` returned nothing; /jobs/<id>
//                      renders the masked label and /bookings/<id> rendered none.
//
// This is wiring across a Deno function, a SQL control and a Next.js server component,
// none of which has a Jest runtime seam — so guard the wiring the way safetyAlert.test.js
// already guards the dispatch path. Each assertion below fails on the pre-fix source.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// The LAST definition of a ctl_ function is the one that wins live, exactly as
// controlRedefinitionCoverage.test.js resolves it.
function latestControlBody(name) {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  let body = null;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const at = sql.indexOf(`create or replace function public.${name}(`);
    if (at === -1) continue;
    const revoke = sql.indexOf(`revoke execute on function public.${name}`, at);
    body = sql.slice(at, revoke === -1 ? sql.length : revoke);
  }
  if (!body) throw new Error(`${name} is defined in no migration`);
  return body;
}

describe('the safety pager tells the on-call where the person is', () => {
  const fn = read('supabase/functions/safety-alert/index.ts');

  test('reads the exact address from job_locations, not the masked jobs column', () => {
    expect(fn).toContain('job_locations');
    expect(fn).toContain('exact_location');
  });

  test('puts it in the email body', () => {
    // The address has to reach the human, not just the function's memory.
    expect(fn).toMatch(/addressLine/);
    expect(fn).toMatch(/<strong>Where:<\/strong>/);
  });

  test('says so when only the masked label is available, rather than passing a city off as the address', () => {
    expect(fn).toMatch(/masked — no exact address on file/);
  });

  test('carries whether the gig is under way — RUNBOOK_SAFETY §1 step 2', () => {
    expect(fn).toContain('started_at');
    expect(fn).toMatch(/in progress/);
  });

  test('links the booking, not only the moderation queue', () => {
    // /moderation is a list. The booking page is where the address, the check-in and
    // the conversation are.
    expect(fn).toMatch(/\/bookings\/\$\{esc\(String\(r\.booking_id\)\)\}/);
  });

  test('the address lookup cannot wedge the page (the report insert must never fail on it)', () => {
    // maybeSingle + optional chaining, never .single() throwing on a gig with no row.
    expect(fn).toMatch(/job_locations'\)\s*\.select\('exact_location'\)\.eq\('job_id', r\.job_id\)\.maybeSingle\(\)/);
  });
});

describe('the overdue check-in finding carries the exact address', () => {
  const body = latestControlBody('ctl_safety_checkin_overdue');

  test('joins job_locations and emits exact_location', () => {
    expect(body).toContain('public.job_locations');
    expect(body).toMatch(/'exact_location'/);
  });

  test('LEFT joins it, so a city-level gig still reports', () => {
    // An INNER join would silently drop the finding for any gig with no captured
    // address — losing the safety alert to protect a field that was never there.
    expect(body).toMatch(/left join public\.job_locations/i);
    expect(body).toMatch(/'exact_location_known'/);
  });

  test('keeps the masked label beside it, and keeps the earner_done exclusion', () => {
    expect(body).toMatch(/'location', j\.location/);
    // 20260806230000 added this to stop paging about workers who had already finished.
    expect(body).toMatch(/not coalesce\(b\.earner_done, false\)/);
  });
});

describe('the console shows the address to the tier that works safety reports', () => {
  const page = read('admin/app/(console)/bookings/[id]/page.tsx');

  test('/bookings/[id] reads job_locations', () => {
    expect(page).toContain('job_locations');
    expect(page).toContain('exact_location');
  });

  test('and the open safety check-in beside it', () => {
    expect(page).toContain('safety_checkins');
  });

  test('gated at trust — the tier that can open /moderation, not the page minimum', () => {
    // The page itself is requireAdminPage("support"); a poster's home address is not
    // part of "a user's own context" that support exists to see.
    expect(page).toMatch(/roleSatisfies\(ctx\.role, "trust"\)/);
  });

  test('reading it is recorded against the admin who read it', () => {
    expect(page).toMatch(/exact_address_shown/);
  });
});

describe('the address is not shipped to the triage LLM', () => {
  const alert = read('supabase/functions/controls-alert/index.ts');

  test('controls-alert redacts exact_location from the Anthropic payload', () => {
    // The digest EMAIL goes to the on-call, who is the audience. The triage payload
    // goes to a third party whose job is prioritisation — widening the control detail
    // without this would have begun mailing posters' home addresses to an LLM daily.
    expect(alert).toMatch(/TRIAGE_REDACT/);
    expect(alert).toMatch(/redactForTriage\(f\.detail\)/);
    expect(alert).toMatch(/'exact_location'/);
  });
});

describe('the runbook sends the on-call to the address', () => {
  const runbook = read('RUNBOOK_SAFETY.md');

  test('§0 names the page that has it and warns off the one that does not', () => {
    expect(runbook).toContain('Where the worker physically is');
    expect(runbook).toMatch(/Not `\/jobs\/<id>`/);
  });

  test('§1 has a step for it', () => {
    expect(runbook).toMatch(/Know where they are before you do anything else/);
    expect(runbook).toMatch(/job_locations/);
  });
});
