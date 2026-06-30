// Browse filter + sort logic, shared by the mobile HomeScreen and the web /browse
// page so both apply identical rules. Extracted from src/components/FilterSheet.js
// and src/screens/HomeScreen.js.
import { haversineMiles } from './geo.js';

export const DEFAULT_FILTERS = {
  payRange:   'any',    // 'any' | 'under25' | '25-50' | '50-100' | '100+'
  days:       [],       // [] = any; ['Mon','Fri'] = those days
  location:   'any',    // 'any' | 'remote' | state abbreviation like 'TX'
  payType:    'any',    // 'any' | 'flat' | 'hourly'
  urgentOnly: false,
  verifiedStudentsOnly: false, // only gigs from Verified Student posters
  campusOnly: false,           // only gigs from posters at the viewer's school
  radius:     'any',    // 'any' | 5 | 10 | 25 | 50 — miles from the center
  near:       null,     // { label, lat, lng } center; null = use the viewer's profile/device location
  sortBy:     'newest', // 'newest' | 'nearest' | 'pay_high' | 'pay_low'
};

// Radius (in miles) options for the "Distance" filter — TaskRabbit/FB-style.
export const RADIUS_OPTIONS = [
  { id: 'any', label: 'Any distance' },
  { id: 5,     label: 'Within 5 mi' },
  { id: 10,    label: 'Within 10 mi' },
  { id: 25,    label: 'Within 25 mi' },
  { id: 50,    label: 'Within 50 mi' },
];

export const DAY_OPTIONS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const PAY_OPTIONS = [
  { id: 'any',      label: 'Any Pay' },
  { id: 'under25',  label: 'Under $25' },
  { id: '25-50',    label: '$25 – $50' },
  { id: '50-100',   label: '$50 – $100' },
  { id: '100+',     label: '$100+' },
];

export const PAY_TYPE_OPTIONS = [
  { id: 'any',    label: 'Any' },
  { id: 'flat',   label: 'Flat Rate' },
  { id: 'hourly', label: 'Hourly' },
];

export const SORT_OPTIONS = [
  { id: 'newest',   label: 'Newest' },
  { id: 'nearest',  label: 'Nearest' },
  { id: 'pay_high', label: 'Pay: High → Low' },
  { id: 'pay_low',  label: 'Pay: Low → High' },
];

export function countActiveFilters(f) {
  let n = 0;
  if (f.payRange   !== 'any')    n++;
  if (f.days.length > 0)         n++;
  if (f.location   !== 'any')    n++;
  if (f.payType    !== 'any')    n++;
  if (f.urgentOnly)              n++;
  if (f.verifiedStudentsOnly)    n++;
  if (f.campusOnly)              n++;
  if (f.radius     !== 'any')    n++;
  if (f.sortBy     !== 'newest') n++;
  return n;
}

// Extract state abbreviation from a location string like "Austin, TX".
export function getState(location) {
  if (!location) return null;
  if (location.toLowerCase().includes('remote')) return 'remote';
  const parts = location.split(',');
  const last = parts[parts.length - 1]?.trim();
  return last?.length === 2 ? last : null;
}

// Extract day abbreviations from a job's open slots (label like "Mon Dec 16, 2:00 PM").
export function getSlotDays(slots) {
  const days = new Set();
  (slots || []).forEach(s => {
    if (!s.taken && s.label) {
      const prefix = s.label.split(' ')[0];
      if (DAY_OPTIONS.includes(prefix)) days.add(prefix);
    }
  });
  return days;
}

// A gig is "For You" if its category, title, or description relates to one of the
// viewer's profile skills. Free-text skills are matched loosely against the gig's
// fixed category (either contains the other) and against title/description text.
export function matchesForYou(job, skills) {
  const sk = (skills || []).map(s => String(s).toLowerCase().trim()).filter(Boolean);
  if (sk.length === 0 || !job) return false;
  const cat = String(job.category || '').toLowerCase().trim();
  const tags = (job.tags || []).map(t => String(t).toLowerCase().trim()).filter(Boolean);
  const title = String(job.title || '').toLowerCase();
  const desc = String(job.description || '').toLowerCase();
  return sk.some(s =>
    (cat && (cat === s || cat.includes(s) || s.includes(cat))) ||
    tags.some(t => t === s || t.includes(s) || s.includes(t)) ||
    title.includes(s) ||
    desc.includes(s),
  );
}

// How well an applicant's skills fit a gig: the count of their skills that relate
// to the job. A skill counts if it relates to the gig's category, any of its tags,
// its title, or its description — using the SAME per-skill matching rule as
// matchesForYou (equal / contains / contained-by, lowercased + trimmed). Used to
// sort applicants by "Job fit". Returns 0 for empty skills or no job.
export function skillFitScore(job, skills) {
  const sk = (skills || []).map(s => String(s).toLowerCase().trim()).filter(Boolean);
  if (sk.length === 0 || !job) return 0;
  const cat = String(job.category || '').toLowerCase().trim();
  const tags = (job.tags || []).map(t => String(t).toLowerCase().trim()).filter(Boolean);
  const title = String(job.title || '').toLowerCase();
  const desc = String(job.description || '').toLowerCase();
  return sk.reduce((n, s) => {
    const hit =
      (cat && (cat === s || cat.includes(s) || s.includes(cat))) ||
      tags.some(t => t === s || t.includes(s) || s.includes(t)) ||
      title.includes(s) ||
      desc.includes(s);
    return hit ? n + 1 : n;
  }, 0);
}

export function matchesPay(job, payRange) {
  if (payRange === 'any') return true;
  const effective = job.payType === 'hourly'
    ? job.pay * (job.estimatedHours || 1)
    : job.pay;
  if (payRange === 'under25')  return effective < 25;
  if (payRange === '25-50')    return effective >= 25  && effective < 50;
  if (payRange === '50-100')   return effective >= 50  && effective < 100;
  if (payRange === '100+')     return effective >= 100;
  return true;
}

// Distinct, sorted list of states present in the jobs (for the location filter).
export function availableStatesFrom(jobs) {
  const states = new Set();
  (jobs || []).forEach(j => {
    const st = getState(j.location);
    if (st && st !== 'remote') states.add(st);
  });
  return Array.from(states).sort();
}

// Apply category chip + search + filters + sort. Returns a new array; attaches
// `_distanceMi` when `userCoords` is provided. Mirrors HomeScreen's useMemo.
export function applyJobFilters(jobs, { selectedCat = 'all', search = '', filters = DEFAULT_FILTERS, blockedIds, userCoords, center, mySchool, forYouSkills = [] } = {}) {
  const schoolKey = (mySchool || '').trim().toLowerCase();
  // Radius filter center: an explicitly chosen location wins, else the default
  // (profile/device location) passed by the caller.
  const radiusCenter = (filters.near && filters.near.lat != null) ? filters.near : center;
  const radiusOn = filters.radius && filters.radius !== 'any' && radiusCenter && radiusCenter.lat != null;
  let list = (jobs || []).filter(j => {
    if (j.status !== 'open') return false;
    if (blockedIds && blockedIds.has?.(j.posterId)) return false;
    if (selectedCat === 'foryou') {
      if (!matchesForYou(j, forYouSkills)) return false;
    } else if (selectedCat !== 'all' && j.category !== selectedCat) return false;

    const q = search.toLowerCase();
    if (q && !j.title.toLowerCase().includes(q) && !j.description.toLowerCase().includes(q)) return false;

    if (!matchesPay(j, filters.payRange)) return false;
    if (filters.payType !== 'any' && j.payType !== filters.payType) return false;
    if (filters.urgentOnly && !j.urgent) return false;
    if (filters.verifiedStudentsOnly && !j.poster?.studentVerified) return false;
    if (filters.campusOnly && (!schoolKey || (j.poster?.school || '').trim().toLowerCase() !== schoolKey)) return false;

    if (filters.location !== 'any') {
      if (filters.location === 'remote') {
        if (!j.location?.toLowerCase().includes('remote')) return false;
      } else if (getState(j.location) !== filters.location) {
        return false;
      }
    }

    // Distance radius — keep remote gigs (location-independent); for in-person gigs
    // require coords within the radius of the center.
    if (radiusOn && !(j.location || '').toLowerCase().includes('remote')) {
      if (j.lat == null || j.lng == null) return false;
      if (haversineMiles(radiusCenter, { lat: j.lat, lng: j.lng }) > filters.radius) return false;
    }

    if (filters.days.length > 0) {
      const slotDays = getSlotDays(j.slots);
      if (!filters.days.some(d => slotDays.has(d))) return false;
    }

    return true;
  });

  if (userCoords) {
    list = list.map(j => ({ ...j, _distanceMi: haversineMiles(userCoords, { lat: j.lat, lng: j.lng }) }));
  }

  const effPay = (j) => (j.payType === 'hourly' ? j.pay * (j.estimatedHours || 1) : j.pay);
  if (filters.sortBy === 'pay_high') {
    list = [...list].sort((a, b) => effPay(b) - effPay(a));
  } else if (filters.sortBy === 'pay_low') {
    list = [...list].sort((a, b) => effPay(a) - effPay(b));
  } else if (filters.sortBy === 'nearest') {
    list = [...list].sort((a, b) => (a._distanceMi ?? Infinity) - (b._distanceMi ?? Infinity));
  } else {
    // 'newest' — bumped gigs float to the top (a bump refreshes bumped_at).
    const freshness = (j) => new Date(j.bumpedAt || j.createdAt || 0).getTime();
    list = [...list].sort((a, b) => freshness(b) - freshness(a));
  }

  return list;
}
