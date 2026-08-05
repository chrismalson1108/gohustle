// Browse filter + sort logic, shared by the mobile HomeScreen and the web /browse
// page so both apply identical rules. Extracted from src/components/FilterSheet.js
// and src/screens/HomeScreen.js.
import { haversineMiles } from './geo.js';
import { resolveCategorySlug, categoryLabel } from './categories.js';

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

// ── Skill ⇄ gig matching ─────────────────────────────────────────────────────
//
// A skill and a gig are related when they share a category IDENTITY: the same slug
// on one of the viewer's skills as on the gig's category or one of its tags. Skills
// and categories are drawn from the same vocabulary (shared/categories.js), so slug
// equality is the whole rule — and it is alias-aware, which is what makes "Lawncare",
// "lawn care" and "Mowing" one thing instead of three.
//
// The rule this replaced compared lowercased strings and accepted a match when
// EITHER contained the other. That is unbounded on the category side, and categories
// are user-creatable now: a two-letter category like "IT" is a substring of the
// preset skill "Fitness", so every fitness-skilled earner was shown IT gigs in For
// You AND every IT applicant's fit score was inflated — which silently mis-ordered
// the poster-facing "Fit" hiring sort, where the ranking is the whole product.
//
// Title/description text stays as a weaker signal, at half the weight, because a
// word in a description is evidence of relevance rather than identity. It matches
// whole words only and ignores skills shorter than MIN_TEXT_SKILL_LEN — that length
// floor is what stops a two-letter skill from firing on every word that happens to
// contain those letters.

const MIN_TEXT_SKILL_LEN = 3;

export const SKILL_MATCH_WEIGHT = { category: 1, text: 0.5 };

// Split any text into comparable words. Mirrors categorySlug's "&" → "and" folding
// so the text path and the slug path agree about "Deck & Patio".
function words(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

// Does `needle` appear in `hay` as a contiguous run of whole words? Word arrays
// rather than a regex so a multi-word skill ("furniture assembly") matches as a
// phrase without any escaping, and so partial words never match.
function hasPhrase(hay, needle) {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    let ok = true;
    for (let k = 0; k < needle.length; k += 1) {
      if (hay[i + k] !== needle[k]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Every category identity a gig carries — its category plus its tags — as slugs.
 * `job.categorySlug` is the stored identity and wins over the display label, which
 * may be a poster's older, un-normalized spelling.
 */
export function jobCategorySlugs(job, extraAliases) {
  const out = new Set();
  if (!job) return out;
  const add = (v) => {
    const slug = resolveCategorySlug(v, extraAliases);
    if (slug) out.add(slug);
  };
  add(job.categorySlug || job.category);
  (Array.isArray(job.tags) ? job.tags : []).forEach(add);
  return out;
}

// Weight for ONE skill against one gig. Identity beats text; a skill that hits both
// still counts once, so the score stays "how many of your skills fit".
function skillWeight(skill, jobSlugs, titleWords, descWords, extraAliases) {
  const raw = String(skill ?? '').trim();
  if (!raw) return 0;
  const slug = resolveCategorySlug(raw, extraAliases);
  if (slug && jobSlugs.has(slug)) return SKILL_MATCH_WEIGHT.category;
  const w = words(raw);
  if (w.join('').length < MIN_TEXT_SKILL_LEN) return 0;
  if (hasPhrase(titleWords, w) || hasPhrase(descWords, w)) return SKILL_MATCH_WEIGHT.text;
  return 0;
}

/**
 * How well an applicant's skills fit a gig — the weighted count of their skills that
 * relate to it. Drives the poster's "Job fit" applicant sort and, via a >0 test, the
 * For You feed. Returns 0 for empty skills or no job.
 */
export function skillFitScore(job, skills, opts) {
  const list = Array.isArray(skills) ? skills : [];
  if (!job || list.length === 0) return 0;
  const extraAliases = opts ? opts.extraAliases : null;
  const jobSlugs = jobCategorySlugs(job, extraAliases);
  const titleWords = words(job.title);
  const descWords = words(job.description);
  const total = list.reduce(
    (n, s) => n + skillWeight(s, jobSlugs, titleWords, descWords, extraAliases),
    0,
  );
  return Math.round(total * 100) / 100;
}

/** A gig is "For You" when any of the viewer's skills fits it. */
export function matchesForYou(job, skills, opts) {
  return skillFitScore(job, skills, opts) > 0;
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

/**
 * Is this gig still worth showing on Browse — i.e. can someone actually book it?
 *
 * `jobs.status` is NOT the answer. Its enum allows 'booked', but nothing in the app
 * ever writes that value (KNOWN_RISKS.md §5.1), so a gig stays 'open' forever no
 * matter how far its bookings progress. That is why a finished gig — both parties
 * done, verified, paid — kept sitting in the Browse feed wearing a green "Completed"
 * badge.
 *
 * Availability lives on the SLOTS. `job_slots.taken` is maintained server-side by the
 * sync_slot_taken trigger on booking status changes, so it is the trustworthy signal:
 * accepting a booking takes the slot, cancelling releases it again.
 *
 * Slot-level rather than job-level matters for multi-slot gigs: one earner booking
 * Tuesday must NOT hide the gig from someone who wants Thursday. Only when every slot
 * is spoken for does the gig stop being bookable.
 *
 * Fails OPEN on a gig with no slots at all: PostJob/EditJob always attach at least a
 * "Flexible" slot, so an empty array means unexpected data, and hiding listings on a
 * data quirk is worse than showing one that can't be booked.
 */
export function isJobBookable(job) {
  if (!job || job.status !== 'open') return false;
  const slots = job.slots;
  if (!Array.isArray(slots) || slots.length === 0) return true;
  return slots.some(s => !s.taken);
}

/**
 * Statuses that mean "this viewer already has this gig" — it should leave their Browse
 * feed even though it may still be bookable by someone else.
 *
 * isJobBookable answers "can ANYONE book this?", which is a property of the gig. This
 * answers "should THIS person still see it?", which is a property of the viewer. A gig
 * with 9 slots and 2 taken is genuinely still open to others, so the slot rule keeps it
 * — but the earner who already completed it was seeing their own finished work in the
 * feed wearing a green "Completed" badge, which is what got reported.
 *
 * 'pending' deliberately stays visible: the applicant hasn't got the job yet and may
 * want to keep seeing it. 'declined' also stays — the slot is free again and re-applying
 * is legitimate.
 */
const MINE_ALREADY = new Set(['confirmed', 'completed', 'verified']);

export function isHiddenForViewer(job, myBookings) {
  if (!job || !myBookings) return false;
  return myBookings.some(b => b.jobId === job.id && MINE_ALREADY.has(b.status));
}

// Apply category chip + search + filters + sort. Returns a new array; attaches
// `_distanceMi` when `userCoords` is provided. Mirrors HomeScreen's useMemo.
//
// `selectedCat` is 'all', 'foryou', or a category SLUG. It is resolved through
// resolveCategorySlug on both sides, so a chip carrying a display label or an alias
// still selects the right gigs — the chip row and the feed can never disagree the
// way a byte-exact `j.category !== selectedCat` comparison let them.
//
// `extraAliases` is the {fromSlug: toSlug} map of merged categories loaded from the
// DB (fetchCategories().aliases); omit it and only the seeded aliases apply.
export function applyJobFilters(jobs, { selectedCat = 'all', search = '', filters = DEFAULT_FILTERS, blockedIds, userCoords, center, mySchool, forYouSkills = [], myBookings, extraAliases } = {}) {
  const schoolKey = (mySchool || '').trim().toLowerCase();
  // Radius filter center: an explicitly chosen location wins, else the default
  // (profile/device location) passed by the caller.
  const radiusCenter = (filters.near && filters.near.lat != null) ? filters.near : center;
  const radiusOn = filters.radius && filters.radius !== 'any' && radiusCenter && radiusCenter.lat != null;
  let list = (jobs || []).filter(j => {
    // Bookability, not just status — see isJobBookable.
    if (!isJobBookable(j)) return false;
    // …and gigs this viewer has already won/finished — see isHiddenForViewer.
    if (isHiddenForViewer(j, myBookings)) return false;
    if (blockedIds && blockedIds.has?.(j.posterId)) return false;
    if (selectedCat === 'foryou') {
      if (!matchesForYou(j, forYouSkills, { extraAliases })) return false;
    } else if (selectedCat !== 'all') {
      const want = resolveCategorySlug(selectedCat, extraAliases);
      if (!want || resolveCategorySlug(j.categorySlug || j.category, extraAliases) !== want) return false;
    }

    // The category label is part of the haystack: people search "plumbing" expecting
    // plumbing gigs, and a poster who titled theirs "Leak under the sink" was
    // unfindable when only the title and description were searched.
    const q = search.toLowerCase().trim();
    if (q) {
      const hay = [j.title, j.description, categoryLabel(j.category || j.categorySlug)]
        .map((s) => String(s ?? '').toLowerCase())
        .join(' ');
      if (!hay.includes(q)) return false;
    }

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
