const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// The safety check-in was designed in two stages — nudge the earner, escalate only
// if that goes unanswered — and only the second stage was ever built. nudged_at and
// escalated_at were columns nothing wrote, so every forgotten "done" tap became a
// CRITICAL page to the on-call within the hour, which is the wolf-crying the design
// memo (20260806180000) says will get the real page ignored.
//
// These assertions are about WIRING, which is exactly what went missing: the
// functions can be perfect and still have no caller.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const sqlOf = new Map(files.map((f) => [f, fs.readFileSync(path.join(MIG, f), 'utf8')]));

// The LAST definition of a function is the one that runs. Pinning any of this to a
// filename would quietly stop checking the body that is live.
function lastDefinition(name) {
  let body = null;
  for (const f of files) {
    const sql = sqlOf.get(f);
    const re = new RegExp(`create or replace function public\\.${name}\\s*\\(`, 'i');
    const m = re.exec(sql);
    if (!m) continue;
    // Search from the LAST occurrence in this file.
    let from = -1;
    let idx = sql.search(re);
    while (idx !== -1) {
      from = idx;
      const next = sql.slice(idx + 1).search(re);
      idx = next === -1 ? -1 : idx + 1 + next;
    }
    const end = sql.indexOf('\n$$;', from);
    const end2 = sql.indexOf('\n$function$;', from);
    const stop = [end, end2].filter((x) => x !== -1).sort((a, b) => a - b)[0];
    body = sql.slice(from, stop === undefined ? sql.length : stop);
  }
  return body;
}

describe('stage one of the safety check-in exists', () => {
  it('some migration WRITES nudged_at', () => {
    const writers = files.filter((f) => /set\s+nudged_at\s*=/.test(sqlOf.get(f)));
    // Before this change the only mentions anywhere were the column DDL and two reads.
    expect(writers.length).toBeGreaterThan(0);
  });

  it('the nudge stage tells the EARNER something, not only the database', () => {
    const body = lastDefinition('run_safety_checkin_stages');
    expect(body).toBeTruthy();
    // A stamp with no message would be the same bug wearing a timestamp.
    expect(body).toMatch(/insert into public\.notifications/i);
    expect(body).toContain('safety_checkin');
    // Never nudge someone who already said they were finished.
    expect(body).toMatch(/earner_done/);
    // Stage two writes the column that says "this one is real".
    expect(body).toMatch(/set\s+escalated_at\s*=\s*now\(\)/i);
  });

  it('the hourly sweep calls it', () => {
    // The whole finding is that a designed function can exist with no caller.
    const sweep = lastDefinition('controls_sweep_and_page');
    expect(sweep).toBeTruthy();
    expect(sweep).toContain('run_safety_checkin_stages');
    expect(sweep).toContain('run_all_controls');
    // Ask first, page second: the nudge must run BEFORE the controls that page.
    expect(sweep.indexOf('run_safety_checkin_stages')).toBeLessThan(sweep.indexOf('run_all_controls'));
  });
});

describe('the page means an unanswered nudge — but silence still pages', () => {
  const control = lastDefinition('ctl_safety_checkin_overdue');

  it('fires on escalation rather than on a missing tap', () => {
    expect(control).toBeTruthy();
    expect(control).toMatch(/escalated_at is not null/);
  });

  it('keeps a hard backstop so a broken nudge cannot silence the control', () => {
    // Gating a SAFETY control on a column another function writes means that if the
    // writer stops, the board goes green while people are unaccounted for.
    expect(control).toMatch(/or c\.due_at < now\(\) - interval '\d+ hours'/);
  });

  it('still excludes an earner who tapped done', () => {
    expect(control).toMatch(/not coalesce\(b\.earner_done, false\)/);
  });
});

describe('the share page describes what actually happens', () => {
  it('no longer claims an automatic check-in the platform never sent', () => {
    const page = fs.readFileSync(path.join(ROOT, 'web/app/s/[token]/page.tsx'), 'utf8');
    expect(page).not.toMatch(/checks in\s+with them automatically/);
    // It should still say something — a friend watching a late gig needs to know
    // whether anyone is doing anything.
    expect(page).toMatch(/reminder in the app/);
  });
});
