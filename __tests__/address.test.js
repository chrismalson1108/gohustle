// Address-privacy masking. maskLocation is mirrored server-side in the SQL function
// public.mask_location (migration 20260722040000_mask_job_location_server_side.sql);
// these cases lock the shared behavior so the two ports stay in sync.
const { maskLocation, canSeeExactAddress } = require('../src/lib/address');

describe('maskLocation', () => {
  test('drops a numbered street line, keeps city/state', () => {
    expect(maskLocation('123 Main St, Dallas, TX')).toBe('Dallas, TX');
  });
  test('drops a spelled-out street line (ends with a street keyword)', () => {
    expect(maskLocation('One Main Street, Uptown, Dallas, TX')).toBe('Uptown, Dallas, TX');
  });
  test('drops an apartment/unit segment', () => {
    expect(maskLocation('Apt 4, 789 Oak Ave, Plano, TX')).toBe('Plano, TX');
  });
  test('leaves an already city-level label unchanged (idempotent)', () => {
    expect(maskLocation('Oak Cliff, Dallas, TX')).toBe('Oak Cliff, Dallas, TX');
    expect(maskLocation('Dallas, TX')).toBe('Dallas, TX');
  });
  test('is idempotent when re-applied to its own output', () => {
    const once = maskLocation('123 Main St, Dallas, TX');
    expect(maskLocation(once)).toBe(once);
  });
  test('passes remote through untouched', () => {
    expect(maskLocation('Remote')).toBe('Remote');
    expect(maskLocation('Remote — anywhere in TX')).toBe('Remote — anywhere in TX');
  });
  test('returns "Nearby area" when only street detail is present', () => {
    expect(maskLocation('123 Main St')).toBe('Nearby area');
  });
  test('passes null/empty through', () => {
    expect(maskLocation(null)).toBe(null);
    expect(maskLocation('')).toBe('');
  });
});

describe('canSeeExactAddress', () => {
  test('poster always sees the exact address', () => {
    expect(canSeeExactAddress({ isPoster: true })).toBe(true);
    expect(canSeeExactAddress({ isPoster: true, bookingStatus: 'pending' })).toBe(true);
  });
  test('an accepted earner sees it; a pending/none one does not', () => {
    expect(canSeeExactAddress({ isPoster: false, bookingStatus: 'confirmed' })).toBe(true);
    expect(canSeeExactAddress({ isPoster: false, bookingStatus: 'completed' })).toBe(true);
    expect(canSeeExactAddress({ isPoster: false, bookingStatus: 'verified' })).toBe(true);
    expect(canSeeExactAddress({ isPoster: false, bookingStatus: 'pending' })).toBe(false);
    expect(canSeeExactAddress({ isPoster: false, bookingStatus: undefined })).toBe(false);
  });
});

// Regression: mask_location used to open with a substring test —
//   if (label.toLowerCase().includes('remote')) return label;
// — intended as "a remote gig has no address to hide". Because it tested the WHOLE
// label, any physical address containing those six letters was published verbatim to
// every signed-in user, which is exactly what the server-side masking work
// (20260722040000) existed to prevent. Both inputs below are ordinary, not contrived:
// "Remote Ridge Rd" is a real street-name shape, and noting "(remote possible)" on a
// physical gig is a natural thing for a poster to type.
describe('maskLocation does not fail open on the word "remote"', () => {
  test('a street address containing "remote" is still masked', () => {
    expect(maskLocation('1234 Remote Ridge Rd, Dallas, TX')).toBe('Dallas, TX');
  });
  test('a street address annotated "(remote possible)" is still masked', () => {
    expect(maskLocation('123 Main St, Dallas, TX (remote possible)'))
      .toBe('Dallas, TX (remote possible)');
  });
  test('genuinely remote labels are preserved (why the shortcut was unnecessary)', () => {
    expect(maskLocation('Remote')).toBe('Remote');
    expect(maskLocation('Remote, Dallas, TX')).toBe('Remote, Dallas, TX');
  });
});

// ── Lockstep: the FOURTH copy ────────────────────────────────────────────────
// maskLocation exists in four places — src/lib/address.js (above), web/lib/address.ts,
// public.mask_location() (20260726030000) and supabase/functions/assistant/index.ts.
// The first three deleted the fail-open "remote" shortcut in 20260726030000; the
// assistant's copy kept it until 2026-09-05 while its own comment claimed to be a
// mirror of address.js, and nothing read it. Dormant is not the same as absent: the
// assistant is the one consumer that already selects job_locations.exact_location, so
// this pins the fourth copy the way moderationSync.test.js pins findProhibited's three.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSISTANT_SRC = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/assistant/index.ts'),
  'utf8',
);
const WEB_SRC = fs.readFileSync(path.join(ROOT, 'web/lib/address.ts'), 'utf8');
const MOBILE_SRC = fs.readFileSync(path.join(ROOT, 'src/lib/address.js'), 'utf8');

function streetSuffixRe(src) {
  const m = src.match(/const STREET_SUFFIX_RE\s*=\s*([\s\S]*?);\n/);
  if (!m) throw new Error('STREET_SUFFIX_RE not found');
  return m[1].replace(/\s+/g, '');
}

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} body unterminated`);
}

// Build a runnable copy of the assistant's maskLocation by stripping the TS
// annotations, so the assertions below exercise the SHIPPED body rather than a
// paraphrase of it.
function loadAssistantMaskLocation() {
  const body = extractFn(ASSISTANT_SRC, 'maskLocation')
    .replace('(location: unknown)', '(location)')
    .replace('): unknown {', ') {');
  const re = ASSISTANT_SRC.match(/const STREET_SUFFIX_RE\s*=\s*([\s\S]*?);\n/)[1];
  // eslint-disable-next-line no-new-func
  return new Function(`const STREET_SUFFIX_RE = ${re};\n${body}\nreturn maskLocation;`)();
}

describe('the assistant edge function mirrors maskLocation exactly', () => {
  const assistantMask = loadAssistantMaskLocation();

  test('carries no "contains remote -> return unmasked" shortcut', () => {
    const fn = extractFn(ASSISTANT_SRC, 'maskLocation');
    expect(fn).not.toMatch(/includes\(\s*['"]remote['"]\s*\)/);
    expect(fn).not.toMatch(/return label;/);
  });

  test('neither do the mobile and web copies (all four stay deleted)', () => {
    expect(extractFn(MOBILE_SRC, 'maskLocation')).not.toMatch(/includes\(\s*['"]remote['"]\s*\)/);
    expect(WEB_SRC.slice(WEB_SRC.indexOf('export function maskLocation')))
      .not.toMatch(/includes\(\s*['"]remote['"]\s*\)/);
  });

  test('its STREET_SUFFIX_RE is byte-identical to the mobile one', () => {
    expect(streetSuffixRe(ASSISTANT_SRC)).toBe(streetSuffixRe(MOBILE_SRC));
    expect(streetSuffixRe(WEB_SRC)).toBe(streetSuffixRe(MOBILE_SRC));
  });

  test('masks the same labels the mobile copy masks', () => {
    const cases = [
      '123 Main St, Dallas, TX',
      'One Main Street, Uptown, Dallas, TX',
      'Apt 4, 789 Oak Ave, Plano, TX',
      'Oak Cliff, Dallas, TX',
      '123 Main St',
      'Remote',
      'Remote, Dallas, TX',
      'Remote — anywhere in TX',
      // The two labels the shortcut published verbatim.
      '1234 Remote Ridge Rd, Dallas, TX',
      '123 Main St, Dallas, TX (remote possible)',
    ];
    for (const label of cases) {
      expect([label, assistantMask(label)]).toEqual([label, maskLocation(label)]);
    }
  });

  test('specifically: a street address containing "remote" is masked', () => {
    expect(assistantMask('1234 Remote Ridge Rd, Dallas, TX')).toBe('Dallas, TX');
    expect(assistantMask('123 Main St, Dallas, TX (remote possible)'))
      .toBe('Dallas, TX (remote possible)');
  });

  test('passes null/empty through like the others', () => {
    expect(assistantMask(null)).toBe(null);
    expect(assistantMask('')).toBe('');
  });
});
