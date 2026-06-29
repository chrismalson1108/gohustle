// Personal earner "Insights" — small, private analytics computed from a single
// earner's OWN completed (verified/paid) bookings. Pure, defensive, no DB calls:
// it only reads the booking shapes produced by transformBooking, so the same
// function powers the mobile "My Jobs" dashboard and the web my-jobs page.

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
// non-array / empty input → []. `area` preserves the original-cased location.
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

    const cat = typeof job.category === 'string' ? job.category.trim() : '';
    if (cat) t.categories.set(cat, (t.categories.get(cat) || 0) + 1);
  }

  const rows = order.map((key) => {
    const t = tallies.get(key);
    const avgPay = t.payN ? Math.round((t.paySum / t.payN) * 100) / 100 : null;
    const top = topEntry(t.categories);
    return {
      area: t.display,
      jobCount: t.count,
      avgPay,
      topCategory: top ? top.key : null,
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

// Title-case a label as a friendly fallback when we have no original casing.
function titleCase(s) {
  return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// computeCertifications(workerReviews, opts) → { certified, progress }.
//   workerReviews: earner-role review rows, each with { rating, job: { category, tags } }.
//   opts: { threshold = 50, minRating = 4.0 }.
// Returns:
//   {
//     certified: [{ label, count, avg }],            // count >= threshold AND avg >= minRating, sorted by count desc
//     progress:  [{ label, count, needed }],         // top (<=3) not-yet-certified labels, sorted by count desc
//   }
// `label` preserves the first-seen original-cased label (or a Title-Cased fallback).
// Defensive: non-array / missing input → empty result.
export function computeCertifications(workerReviews, opts) {
  const threshold = opts && Number.isFinite(opts.threshold) ? opts.threshold : 50;
  const minRating = opts && Number.isFinite(opts.minRating) ? opts.minRating : 4.0;

  const list = Array.isArray(workerReviews) ? workerReviews : [];

  // key (lowercased/trimmed) → { count, ratingSum, display }
  const tallies = new Map();

  const bump = (raw, rating) => {
    if (typeof raw !== 'string') return;
    const display = raw.trim();
    if (!display) return;
    const key = display.toLowerCase();
    let t = tallies.get(key);
    if (!t) {
      t = { count: 0, ratingSum: 0, display };
      tallies.set(key, t);
    }
    t.count += 1;
    t.ratingSum += Number.isFinite(Number(rating)) ? Number(rating) : 0;
  };

  for (const r of list) {
    if (!r || !r.job) continue;
    const rating = r.rating;
    bump(r.job.category, rating);
    const tags = Array.isArray(r.job.tags) ? r.job.tags : [];
    for (const tag of tags) bump(tag, rating);
  }

  const certified = [];
  const remaining = [];
  for (const t of tallies.values()) {
    const avg = t.count ? t.ratingSum / t.count : 0;
    const label = t.display || titleCase(t.display);
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
