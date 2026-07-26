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
