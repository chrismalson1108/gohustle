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
