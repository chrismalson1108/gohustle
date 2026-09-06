// ─────────────────────────────────────────────────────────────────────────────
// The address masker is one trigger with nothing behind it, and now it has a canary.
//
// `jobs.location` is published to every signed-in user and is supposed to hold only a
// city-level label; the exact street address belongs in `job_locations` behind RLS.
// The only thing that arranges that is trg_mask_job_location -> capture_job_location().
// There is no CHECK constraint, no masking view, and jobs_select_all is USING(true)
// modulo the suspended-poster carve-out. CLAUDE.md states the consequence plainly: a
// session that "fixes" the masking "publishes every street address on the platform".
//
// parity.test.js already has "the address-masking contract is documented", whose banner
// says it keeps the contract "wired" — but every assertion in it reads CLAUDE.md. Prose
// cannot notice a dropped trigger. ctl_job_location_unmasked
// (20260906052000_canary_for_the_address_masking_nobody_watches.sql) is the assertion
// against DATA; this file is the assertion that the canary itself stays the right shape.
//
// Every test here fails on the code before that migration, because the control did not
// exist: `grep -n 'mask_location\|job_locations' supabase/migrations/*.sql | grep -i ctl_`
// returned nothing at all.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');
const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const sql = files.map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')).join('\n');

// The LAST definition wins in a `create or replace` chain, so read the newest file that
// defines the function rather than the first — five files have defined the masker.
function lastBodyOf(fnName) {
  let body = null;
  for (const f of files) {
    const src = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    const re = new RegExp(`create or replace function public\\.${fnName}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      const rest = src.slice(m.index);
      const open = rest.indexOf('as $$');
      const close = rest.indexOf('$$;', open);
      if (open !== -1 && close !== -1) body = rest.slice(open + 5, close);
    }
  }
  return body;
}

describe('the address masker is watched by a control, not only by prose', () => {
  const body = lastBodyOf('ctl_job_location_unmasked');

  it('defines ctl_job_location_unmasked', () => {
    expect(`defined: ${body !== null}`).toBe('defined: true');
  });

  it('registers it, or run_all_controls never calls it', () => {
    // run_all_controls iterates the REGISTRY, so an unregistered check reports nothing
    // forever while /controls still shows green.
    expect(sql).toMatch(/\(\s*'job_location_unmasked',[\s\S]*?'ctl_job_location_unmasked'\)/);
  });

  it('registers it as a critical security control', () => {
    // A leaked home address is not a lifecycle nit. The severity is what the sweep pages
    // on and what the digest sorts by.
    const row = sql.match(/\(\s*'job_location_unmasked',[\s\S]*?'ctl_job_location_unmasked'\)/)[0];
    expect(row).toMatch(/'critical',\s*'security'/);
  });

  it('asks mask_location itself instead of deciding for itself what an address is', () => {
    // THE POINT OF THIS FILE. A hand-rolled regex here would be a second definition of
    // "what counts as an address", free to drift from the one the trigger enforces — and
    // the drift would be silent in the direction that looks healthy.
    expect(body).toMatch(/public\.mask_location\(j\.location\)/);
    // No segment parsing of its own: no regex match operator, no comma splitting, no
    // street-keyword list.
    expect(`splits segments itself: ${/string_to_array|regexp_split|\s~\*?\s/.test(body)}`)
      .toBe('splits segments itself: false');
  });

  it('mirrors capture_job_location and stays silent on a blank label', () => {
    // The trigger returns early when btrim(location) = '', but mask_location('') is
    // 'Nearby area', so without the same exclusion the canary would report a healthy row
    // it deliberately never touched. Permanent noise is how a control gets muted.
    expect(body).toMatch(/btrim\(j\.location\)\s*<>\s*''/);
  });

  it('is not scoped to open gigs', () => {
    // jobs_select_all does not mention status: a booked, completed or cancelled row is
    // just as readable. Narrowing the canary to `open` would mean the trigger could be
    // dropped and every gig that filled in the meantime would go unreported.
    expect(`filters on status: ${/j\.status\s*(=|in)\s/.test(body)}`).toBe('filters on status: false');
  });

  it('checks the coordinate snap with the rounding the trigger actually applies', () => {
    // capture_job_location does `new.lat := round(new.lat::numeric, 2)`. Any other
    // precision here would either miss the leak or invent one.
    expect(body).toMatch(/round\(j\.lat::numeric,\s*2\)/);
    expect(body).toMatch(/round\(j\.lng::numeric,\s*2\)/);
  });

  it('emits at most one row per job', () => {
    // run_control upserts the control's whole output in one statement
    // (`insert ... select from v on conflict do update`), so the same entity_id twice in
    // a single run is a cardinality violation — the control would ERROR rather than
    // report, which is the one outcome worse than a missed finding. Both arms therefore
    // share a row, with `arms` naming what tripped.
    expect(`unions arms into separate rows: ${/\bunion\b/i.test(body)}`)
      .toBe('unions arms into separate rows: false');
    expect(body).toMatch(/'arms'/);
  });

  it('does not copy the leaked coordinates into control_findings', () => {
    // A finding about a leaked home location should not reproduce that location in a
    // second table in order to report it. The job id is enough to look it up.
    expect(body).toMatch(/lat_decimals/);
    expect(`reports raw coords: ${/'lat',\s*j\.lat|'lng',\s*j\.lng/.test(body)}`)
      .toBe('reports raw coords: false');
  });

  it('proves itself in the migration rather than asserting a formula', () => {
    // House rule: a fix ships with a rolled-back probe that stages the broken row and
    // shows the check discriminates. Here that means disabling the trigger — the exact
    // regression — and showing the same insert is silent with it on.
    const file = fs.readFileSync(
      path.join(MIGRATIONS, '20260906052000_canary_for_the_address_masking_nobody_watches.sql'),
      'utf8',
    );
    expect(file).toMatch(/alter table public\.jobs disable trigger trg_mask_job_location/);
    expect(file).toMatch(/alter table public\.jobs enable trigger trg_mask_job_location/);
    expect(file).toMatch(/probe complete — rolling back/);
  });
});

describe('the thing the canary watches is still what masks the address', () => {
  // If any of these stops being true the control is watching a mechanism that no longer
  // exists, which is a canary that can never sing.
  const capture = lastBodyOf('capture_job_location');

  it('capture_job_location still rewrites the public column to the masked form', () => {
    expect(capture).toMatch(/masked\s*:=\s*public\.mask_location\(new\.location\)/);
    expect(capture).toMatch(/new\.location\s*:=\s*masked/);
  });

  it('it still files the exact label in job_locations before overwriting', () => {
    // Without this the "fix" for a finding — touching the row — would destroy the address
    // the accepted earner needs in order to turn up.
    expect(capture).toMatch(/insert into public\.job_locations/);
  });

  it('it still snaps the coordinates', () => {
    expect(capture).toMatch(/new\.lat\s*:=\s*round\(new\.lat::numeric,\s*2\)/);
    expect(capture).toMatch(/new\.lng\s*:=\s*round\(new\.lng::numeric,\s*2\)/);
  });

  it('a trigger still calls it on both insert and update', () => {
    expect(sql).toMatch(
      /create trigger trg_mask_job_location\s+before insert or update on public\.jobs[\s\S]{0,120}capture_job_location/,
    );
  });
});
