// Address privacy. Job coords are already snapped to ~1.1 km before publish
// (JobsContext addJob/updateJob round lat/lng to 2 decimals), but the location
// LABEL is free text — a poster can type "123 Main St, Dallas, TX" and it would
// otherwise show verbatim to every browser. maskLocation() reduces a label to
// its city-level parts for viewers who haven't been accepted on the job yet;
// the exact address is shown to the poster and to the earner once their booking
// is confirmed.
// A comma segment that ENDS with a street/unit keyword is a street line even when
// it has no digits (spelled-out numbers, "Main Street", "Apt", "Suite"). Anchored
// at the end so ordinary city/state segments ("Dallas", "TX", "Oak Cliff") pass.
const STREET_SUFFIX_RE =
  /\b(st|street|ave|avenue|blvd|boulevard|rd|road|ln|lane|dr|drive|ct|court|pl|place|ter|terrace|cir|circle|hwy|highway|pkwy|parkway|trl|trail|apt|apartment|ste|suite|unit|fl|floor|rm|room)\b\.?$/i;

export function maskLocation(location) {
  if (!location) return location;
  const label = String(location);
  if (label.toLowerCase().includes('remote')) return label;
  const parts = label.split(',').map((p) => p.trim()).filter(Boolean);
  // Street lines are the segments containing digits ("123 Main St", "Apt 4",
  // "Ste 100") OR ending in a street/unit keyword ("One Main Street", "Apt Four").
  // City/state segments ("Dallas", "TX", "Oak Cliff") don't match either.
  const safe = parts.filter((p) => !/\d/.test(p) && !STREET_SUFFIX_RE.test(p));
  if (safe.length > 0) return safe.join(', ');
  return 'Nearby area';
}

// True when the viewer may see the exact address: the poster themselves, or an
// earner whose booking on this job has been accepted (confirmed or later).
export function canSeeExactAddress({ isPoster, bookingStatus }) {
  if (isPoster) return true;
  return ['confirmed', 'completed', 'verified'].includes(bookingStatus || '');
}
