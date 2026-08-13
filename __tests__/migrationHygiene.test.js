// ─────────────────────────────────────────────────────────────────────────────
// Two migration files must never share a timestamp.
//
// supabase_migrations.schema_migrations is keyed on the VERSION, which is the leading
// timestamp of the filename — not the whole name. So a second file with a timestamp
// that is already recorded fails on the primary key, and it fails in a way that reads
// like something else entirely: the push reports `duplicate key value violates unique
// constraint "schema_migrations_pkey"` with no mention of which file, and repairing the
// version or re-pushing reproduces it forever.
//
// It cost a real detour today. Worse, the first failed push left the state looking
// APPLIED (version recorded) while nothing had been applied — so the security fix in
// 20260813090000 silently did nothing, and only a direct privilege query showed it.
//
// One second of comparing filenames beats diagnosing that again.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'supabase', 'migrations');

describe('migration filenames', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql'));

  it('has migrations to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never reuses a timestamp', () => {
    const byVersion = {};
    for (const f of files) {
      const version = f.split('_')[0];
      (byVersion[version] ||= []).push(f);
    }
    const collisions = Object.entries(byVersion).filter(([, fs_]) => fs_.length > 1);
    // Name the actual files — the CLI's own error does not.
    expect(collisions.map(([v, fs_]) => `${v}: ${fs_.join(' + ')}`)).toEqual([]);
  });

  it('starts every filename with a 14-digit timestamp', () => {
    // A malformed prefix parses to a version that sorts unpredictably, which silently
    // changes the order migrations apply in.
    const bad = files.filter((f) => !/^\d{14}_/.test(f));
    expect(bad).toEqual([]);
  });
});
