// Badge rules — the single source of truth for whether a badge is earned.
//
// Pure functions over a plain snapshot so they're testable without a DB and
// usable from both mobile and web. Every key in BADGE_DEFS must have a rule
// here (enforced by __tests__/badges.test.js).
//
// SAFETY: rules are monotonic — missing data must read as "not yet earned",
// never as earned. Callers may evaluate with partial context (e.g. before
// reviews have loaded); unlocking is append-only so a later pass fills gaps.

import { BADGE_DEFS } from './constants.js';

const DONE = ['completed', 'verified'];

// ── snapshot helpers ───────────────────────────────────────────────────────
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

/** Bookings this user worked and finished. */
function doneBookings(ctx) {
  return arr(ctx.bookings).filter(b => DONE.includes(b?.status));
}

/** Bookings on this user's own listings that reached verified. */
function verifiedHires(ctx) {
  return arr(ctx.posterBookings).filter(b => b?.status === 'verified');
}

/** Local hour-of-day for a slot start, or null when unknown. */
function startHour(booking) {
  const iso = booking?.startsAt || booking?.startedAt;
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.getHours();
}

function startDay(booking) {
  const iso = booking?.startsAt || booking?.startedAt || booking?.completedAt;
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.getDay(); // 0=Sun .. 6=Sat
}

function countBy(list, keyFn) {
  const m = new Map();
  list.forEach(item => {
    const k = keyFn(item);
    if (k == null) return;
    m.set(k, (m.get(k) || 0) + 1);
  });
  return m;
}

// ── rules ──────────────────────────────────────────────────────────────────
// Each rule returns { earned, current, target } so the UI can render progress
// on locked badges. `target` null means it's a yes/no achievement.

const RULES = {
  // Work ------------------------------------------------------------------
  firstHustle:  (c) => count(doneBookings(c).length, 1),
  tenGigs:      (c) => count(doneBookings(c).length, 10),
  quarterTon:   (c) => count(doneBookings(c).length, 25),
  centurion:    (c) => count(doneBookings(c).length, 100),

  // Earnings --------------------------------------------------------------
  firstHundred: (c) => count(num(c.earningsTotal), 100),
  bigEarner:    (c) => count(num(c.earningsTotal), 1000),
  highRoller:   (c) => count(num(c.earningsTotal), 5000),
  wellTipped:   (c) => flag(arr(c.bookings).some(b => num(b?.tipAmount) > 0)),

  // Reputation ------------------------------------------------------------
  fiveStar:     (c) => count(arr(c.reviews).filter(r => num(r?.rating) >= 5).length, 1),
  topRated:     (c) => count(arr(c.reviews).filter(r => num(r?.rating) >= 5).length, 10),
  crowdPleaser: (c) => count(arr(c.reviews).length, 25),
  onFire:       (c) => count(num(c.streakDays), 5),
  unstoppable:  (c) => count(num(c.streakDays), 10),

  // Style -----------------------------------------------------------------
  // Applied within 30 min of the gig being posted. Needs both timestamps.
  speedDemon: (c) => flag(arr(c.bookings).some(b => {
    const applied = b?.createdAt ? new Date(b.createdAt).getTime() : NaN;
    const posted = b?.job?.createdAt ? new Date(b.job.createdAt).getTime() : NaN;
    if (isNaN(applied) || isNaN(posted)) return false;
    const mins = (applied - posted) / 60000;
    return mins >= 0 && mins <= 30;
  })),
  earlyBird: (c) => flag(doneBookings(c).some(b => {
    const h = startHour(b);
    return h != null && h < 8;
  })),
  nightOwl: (c) => flag(doneBookings(c).some(b => {
    const h = startHour(b);
    return h != null && h >= 20;
  })),
  weekendWared: (c) => count(
    doneBookings(c).filter(b => { const d = startDay(b); return d === 0 || d === 6; }).length,
    5,
  ),
  jackOfAll: (c) => count(
    new Set(doneBookings(c).map(b => b?.job?.category).filter(Boolean)).size,
    5,
  ),
  regular: (c) => {
    const byPoster = countBy(doneBookings(c), b => b?.job?.posterId || null);
    const best = byPoster.size ? Math.max(...byPoster.values()) : 0;
    return count(best, 3);
  },
  negotiator: (c) => flag(arr(c.bookings).some(b =>
    num(b?.counterOffer) > 0 && DONE.concat('confirmed').includes(b?.status),
  )),

  // Hiring ----------------------------------------------------------------
  firstPost:  (c) => count(arr(c.postedJobs).length, 1),
  goodBoss:   (c) => count(verifiedHires(c).length, 5),
  // An accepted counter-offer supersedes the listed pay; fall back to the listing.
  bigSpender: (c) => count(
    verifiedHires(c).reduce((s, b) => s + (num(b?.counterOffer) || num(b?.job?.pay)), 0),
    1000,
  ),
  tipper: (c) => count(arr(c.posterBookings).filter(b => num(b?.tipAmount) > 0).length, 3),

  // Trust -----------------------------------------------------------------
  idVerified: (c) => flag(!!c.verified),
  allStar: (c) => flag(
    !!c.avatarUrl && !!(c.bio && String(c.bio).trim().length > 0) && arr(c.skills).length >= 3,
  ),
  connector: (c) => count(num(c.referrals), 1),
};

function count(current, target) {
  return { earned: current >= target, current: Math.min(current, target), target };
}
function flag(ok) {
  return { earned: !!ok, current: ok ? 1 : 0, target: null };
}

/** Every badge key that has a rule. */
export const BADGE_KEYS = Object.keys(BADGE_DEFS);

/**
 * A fully-populated locked map covering the WHOLE catalogue.
 * State must be seeded from this — a hand-listed subset silently drops rows
 * loaded from the DB, so those badges re-unlock (and re-toast) every session.
 */
export function emptyBadgeMap() {
  return Object.fromEntries(BADGE_KEYS.map(k => [k, { unlocked: false }]));
}

/**
 * Evaluate one badge against a snapshot.
 * @returns {{earned:boolean,current:number,target:number|null}}
 */
export function badgeStatus(key, ctx = {}) {
  const rule = RULES[key];
  if (!rule) return { earned: false, current: 0, target: null };
  try {
    return rule(ctx) || { earned: false, current: 0, target: null };
  } catch {
    // A malformed row must never crash the profile screen or falsely unlock.
    return { earned: false, current: 0, target: null };
  }
}

/**
 * All badge keys the snapshot currently earns.
 * @returns {string[]}
 */
export function evaluateBadges(ctx = {}) {
  return BADGE_KEYS.filter(k => badgeStatus(k, ctx).earned);
}

/**
 * Keys that are earned now but not yet recorded as unlocked.
 * @param {object} ctx snapshot
 * @param {object} existing map of key -> { unlocked: bool }
 */
export function newlyEarned(ctx = {}, existing = {}) {
  return evaluateBadges(ctx).filter(k => !existing?.[k]?.unlocked);
}
