// Address privacy. Job coords are already snapped to ~1.1 km before publish
// (JobsContext addJob/updateJob round lat/lng to 2 decimals), but the location
// LABEL is free text — a poster can type "123 Main St, Dallas, TX" and it would
// otherwise show verbatim to every browser. maskLocation() reduces a label to
// its city-level parts for viewers who haven't been accepted on the job yet;
// the exact address is shown to the poster and to the earner once their booking
// is confirmed.
export function maskLocation(location) {
  if (!location) return location;
  const label = String(location);
  if (label.toLowerCase().includes('remote')) return label;
  const parts = label.split(',').map((p) => p.trim()).filter(Boolean);
  // Street lines are the segments containing digits ("123 Main St", "Apt 4",
  // "Ste 100"). City/state segments ("Dallas", "TX", "Oak Cliff") don't.
  const safe = parts.filter((p) => !/\d/.test(p));
  if (safe.length > 0) return safe.join(', ');
  return 'Nearby area';
}

// True when the viewer may see the exact address: the poster themselves, or an
// earner whose booking on this job has been accepted (confirmed or later).
export function canSeeExactAddress({ isPoster, bookingStatus }) {
  if (isPoster) return true;
  return ['confirmed', 'completed', 'verified'].includes(bookingStatus || '');
}
