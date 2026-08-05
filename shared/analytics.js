// Personal earner "Insights" — small, private analytics computed from a single
// earner's OWN completed (verified/paid) bookings. Pure, defensive, no DB calls:
// it only reads the booking shapes produced by transformBooking, so the same
// function powers the mobile "My Jobs" dashboard and the web my-jobs page.
import { resolveCategorySlug, categoryLabel } from './categories.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Dollars an earner actually made on a booking: the agreed price (a counter-offer
// overrides the job's listed pay) plus any tip.
function earnedFor(b) {
  const base = b?.counterOffer != null ? Number(b.counterOffer) : Number(b?.job?.pay);
  const pay = Number.isFinite(base) ? base : 0;
  const tip = Number(b?.tipAmount) || 0;
  return pay + tip;
}

// Weekday name for the booking, preferring when the work was completed, then when
// it was scheduled to start, then when it was created. Returns null if no usable date.
function weekdayFor(b) {
  const raw = b?.completedAt || b?.startsAt || b?.createdAt;
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return WEEKDAYS[d.getDay()];
}

// Given a Map of key → number, return the entry with the highest value (ties → first
// inserted). Returns null for an empty map.
function topEntry(map) {
  let bestKey = null;
  let bestVal = -Infinity;
  for (const [key, val] of map) {
    if (val > bestVal) {
      bestVal = val;
      bestKey = key;
    }
  }
  return bestKey == null ? null : { key: bestKey, value: bestVal };
}

// computeEarnerInsights(bookings) → insights over the earner's verified bookings.
// Returns null when there's nothing to show (no verified bookings) so the UI can hide.
//   {
//     topArea:           { label: string, count: number } | null,
//     busiestDay:        { label: string, count: number } | null,
//     mostProfitableDay: { label: string, total: number } | null,
//     jobCount:          number,
//   }
export function computeEarnerInsights(bookings) {
  const list = Array.isArray(bookings) ? bookings : [];
  const completed = list.filter((b) => b && b.status === 'verified');
  if (!completed.length) return null;

  const areaCounts = new Map(); // location → # of gigs
  const dayCounts = new Map(); // weekday → # of gigs
  const dayTotals = new Map(); // weekday → summed earnings

  for (const b of completed) {
    const area = b?.job?.location;
    if (typeof area === 'string' && area.trim()) {
      const key = area.trim();
      areaCounts.set(key, (areaCounts.get(key) || 0) + 1);
    }

    const day = weekdayFor(b);
    if (day) {
      dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
      dayTotals.set(day, (dayTotals.get(day) || 0) + earnedFor(b));
    }
  }

  const topArea = topEntry(areaCounts);
  const busiest = topEntry(dayCounts);
  const profitable = topEntry(dayTotals);

  return {
    topArea: topArea ? { label: topArea.key, count: topArea.value } : null,
    busiestDay: busiest ? { label: busiest.key, count: busiest.value } : null,
    mostProfitableDay: profitable
      ? { label: profitable.key, total: Math.round(profitable.value * 100) / 100 }
      : null,
    jobCount: completed.length,
  };
}

// ── Market Insights fallback (the Pro area heat-map) ──────────────────────────
// computeAreaInsights(jobs) → per-area aggregates from the PUBLIC open-jobs list
// the app already has loaded. Used as the client-side fallback when the
// `area_market_stats` RPC errors or returns nothing. Only covers what the public
// jobs feed can show — job density, average pay, and the most common category.
// Tips + worker density are NOT here (they need the privileged RPC).
//
// Returns: [{ area, jobCount, avgPay, topCategory }, ...] for areas with
// jobCount >= 1, sorted by jobCount desc (ties → first-seen area). Defensive:
// non-array / empty input → []. `area` preserves the original-cased location;
// `topCategory` is the canonical category label.
export function computeAreaInsights(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];

  // key (lowercased/trimmed) → { display, count, paySum, payN, categories: Map }
  const tallies = new Map();
  const order = []; // first-seen key order for stable tie-breaking

  for (const job of list) {
    if (!job) continue;
    const rawArea = job.location;
    if (typeof rawArea !== 'string') continue;
    const display = rawArea.trim();
    if (!display) continue;

    const key = display.toLowerCase();
    let t = tallies.get(key);
    if (!t) {
      t = { display, count: 0, paySum: 0, payN: 0, categories: new Map() };
      tallies.set(key, t);
      order.push(key);
    }
    t.count += 1;

    const pay = Number(job.pay);
    if (Number.isFinite(pay)) {
      t.paySum += pay;
      t.payN += 1;
    }

    // Tally by SLUG. The area key on the line above was already case-folded, but
    // categories were counted byte-exact, so "Lawn Care" and "lawn care" competed
    // as two separate candidates for the same area's top category — and could
    // between them lose to a third category neither of them beat.
    const slug = resolveCategorySlug(job.categorySlug || job.category);
    if (slug) t.categories.set(slug, (t.categories.get(slug) || 0) + 1);
  }

  const rows = order.map((key) => {
    const t = tallies.get(key);
    const avgPay = t.payN ? Math.round((t.paySum / t.payN) * 100) / 100 : null;
    const top = topEntry(t.categories);
    return {
      area: t.display,
      jobCount: t.count,
      avgPay,
      topCategory: top ? categoryLabel(top.key) : null,
    };
  });

  // jobCount desc; preserve first-seen order for ties (stable sort in modern JS).
  rows.sort((a, b) => b.jobCount - a.jobCount);
  return rows;
}

// ── Hustlr Certified ──────────────────────────────────────────────────────────
// A worker becomes "Certified" in a category/tag once they've completed
// >= 50 jobs in that label at an average rating >= 4.0★. Computed purely from a
// worker's `reviews` (role === 'earner') joined to the job's `category`/`tags`.
// No DB migration — same data the public profile already fetches.

// computeCertifications(workerReviews, opts) → { certified, progress }.
//   workerReviews: earner-role review rows, each with { rating, job: { category, tags } }.
//   opts: { threshold = 50, minRating = 4.0 }.
// Returns:
//   {
//     certified: [{ label, count, avg }],            // count >= threshold AND avg >= minRating, sorted by count desc
//     progress:  [{ label, count, needed }],         // top (<=3) not-yet-certified labels, sorted by count desc
//   }
// Tallies are keyed by category SLUG and displayed through categoryLabel(), so a
// worker's 50 gigs cannot fragment across spellings. That matters more here than
// anywhere else: a certification is a public trust claim, and a threshold nobody
// can reach because their history splits three ways is a feature that never fires.
// Defensive: non-array / missing input → empty result.
export function computeCertifications(workerReviews, opts) {
  const threshold = opts && Number.isFinite(opts.threshold) ? opts.threshold : 50;
  const minRating = opts && Number.isFinite(opts.minRating) ? opts.minRating : 4.0;

  const list = Array.isArray(workerReviews) ? workerReviews : [];

  // slug → { count, ratingSum, display (first-seen raw label) }
  const tallies = new Map();

  const bump = (slug, display, rating) => {
    let t = tallies.get(slug);
    if (!t) {
      t = { count: 0, ratingSum: 0, display };
      tallies.set(slug, t);
    }
    t.count += 1;
    t.ratingSum += Number.isFinite(Number(rating)) ? Number(rating) : 0;
  };

  for (const r of list) {
    if (!r || !r.job) continue;
    const tags = Array.isArray(r.job.tags) ? r.job.tags : [];
    // Identity from the slug where the row has one, display from the label. One gig
    // counts ONCE per category however many of its fields name that category — a gig
    // tagged with its own category used to be counted twice, inflating the public
    // "50 jobs" claim with work that was never done.
    const seen = new Map();
    const note = (identity, display) => {
      if (typeof identity !== 'string' || !identity.trim()) return;
      const slug = resolveCategorySlug(identity);
      if (slug && !seen.has(slug)) seen.set(slug, String(display || identity).trim());
    };
    note(r.job.categorySlug || r.job.category, r.job.category || r.job.categorySlug);
    for (const tag of tags) note(tag, tag);
    for (const [slug, display] of seen) bump(slug, display, r.rating);
  }

  const certified = [];
  const remaining = [];
  for (const [slug, t] of tallies) {
    const avg = t.count ? t.ratingSum / t.count : 0;
    const label = categoryLabel(t.display || slug);
    if (t.count >= threshold && avg >= minRating) {
      certified.push({ label, count: t.count, avg: Math.round(avg * 100) / 100 });
    } else {
      remaining.push({ label, count: t.count, needed: threshold });
    }
  }

  certified.sort((a, b) => b.count - a.count);
  remaining.sort((a, b) => b.count - a.count);

  return { certified, progress: remaining.slice(0, 3) };
}
