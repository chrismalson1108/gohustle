const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// estimated_hours is PRICE, not metadata.
//
// The escrow hold on an hourly gig is pay x estimated_hours — trg_z_pin_booking_amount
// (supabase/migrations/20260806000000_pin_booking_amount.sql and every migration that
// has redefined it since) pins amount_cents_quoted from that product, and
// stripe-create-payment-intent computes the same product when it mints the hold.
//
// PostJobScreen has always collected the number, but EditJobScreen had only the
// Flat / "/hr" toggle and JobsContext.updateJob's dbPatch omitted the column entirely,
// while web/lib/jobs.tsx wrote it. So a poster on mobile could switch an unbooked flat
// gig to hourly, change the rate, and never be asked for the hours — the value the gig
// was posted with stayed the multiplier for every future booking. A $60 flat gig
// re-listed at $20/hr for a four-hour job held $20.
//
// Both halves are asserted here because either alone leaves the bug: a field nobody
// writes, or a column nobody can set.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('EditJobScreen collects estimated hours for hourly gigs', () => {
  const src = read('src/screens/EditJobScreen.js');

  it('seeds the form from the gig', () => {
    expect(src).toMatch(/estHours:\s*job\?\.estimatedHours/);
  });

  it('renders an hours input, gated on the hourly pay type', () => {
    expect(src).toMatch(/form\.payType === 'hourly' && \(\s*<Field label=\{`Estimated hours \*/);
    expect(src).toMatch(/value=\{form\.estHours\}/);
    expect(src).toMatch(/onChangeText=\{v => set\('estHours', v\)\}/);
  });

  it('locks the field alongside pay once a booking is live', () => {
    // guard_jobs_write pins estimated_hours whenever a booking is
    // confirmed/completed/verified, exactly as it pins pay — the UI must not offer an
    // edit the server will silently discard.
    const block = src.slice(src.indexOf('Estimated hours *'));
    expect(block.slice(0, 900)).toMatch(/canEditPay \?/);
  });

  it('sends the hours to updateJob for hourly gigs only', () => {
    expect(src).toMatch(
      /form\.payType === 'hourly'\s*\?\s*\{\s*estimatedHours:\s*Math\.max\(1,\s*parseFloat\(form\.estHours\)\s*\|\|\s*1\)\s*\}/,
    );
  });
});

describe('JobsContext.updateJob writes estimated_hours', () => {
  const src = read('src/context/JobsContext.js');

  it('maps estimatedHours onto the db patch', () => {
    expect(src).toMatch(
      /if \(jobData\.estimatedHours !== undefined\) dbPatch\.estimated_hours = jobData\.estimatedHours;/,
    );
  });

  it('does it inside updateJob, not only addJob', () => {
    const start = src.indexOf('const updateJob = async');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('const { error } = await supabase.from(\'jobs\').update(dbPatch)', start));
    expect(body).toMatch(/dbPatch\.estimated_hours/);
  });
});

describe('mobile and web edit forms agree', () => {
  it('both write the column on an edit', () => {
    expect(read('web/lib/jobs.tsx')).toMatch(/dbPatch\.estimated_hours = d\.estimatedHours/);
    expect(read('src/context/JobsContext.js')).toMatch(/dbPatch\.estimated_hours = jobData\.estimatedHours/);
  });

  it('both render an hours field', () => {
    expect(read('web/components/GigForm.tsx')).toMatch(/value=\{estimatedHours\}/);
    expect(read('src/screens/EditJobScreen.js')).toMatch(/value=\{form\.estHours\}/);
    expect(read('src/screens/PostJobScreen.js')).toMatch(/value=\{form\.estHours\}/);
  });
});
