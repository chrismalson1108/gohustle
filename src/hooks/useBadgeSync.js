import { useEffect, useRef } from 'react';
import { newlyEarned } from '../../shared/badges.js';
import { BADGE_DEFS } from '../data/mockData';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';

// Evaluates the badge rules against live profile + booking data and unlocks
// anything newly earned, toasting each one.
//
// Unlocking is append-only and unlockBadge() is a no-op for already-unlocked
// keys, so this is safe to mount on several screens and safe to run against
// partially-loaded data — a later pass picks up whatever was missing.
//
// `extra` carries data the contexts don't hold (reviews, referral count) from
// whichever screen already fetched it.
export function useBadgeSync(extra = {}) {
  const {
    badges, unlockBadge, showToast,
    earningsTotal, streakDays, verified, avatarUrl, bio, skills,
  } = useUser();
  const { bookings, posterBookings, postedJobs } = useJobs();

  // Toast only for badges earned during this session — not for the backlog a
  // returning user already has.
  const primed = useRef(false);

  const { reviews, referrals } = extra;

  useEffect(() => {
    const ctx = {
      bookings, posterBookings, postedJobs,
      earningsTotal, streakDays, verified, avatarUrl, bio, skills,
      reviews, referrals,
    };

    const fresh = newlyEarned(ctx, badges);
    if (fresh.length === 0) { primed.current = true; return; }

    const announce = primed.current;
    fresh.forEach(key => {
      unlockBadge(key);
      if (announce) {
        const def = BADGE_DEFS[key];
        showToast?.({
          icon: def?.icon || '🏅',
          title: `Badge unlocked — ${def?.label || key}!`,
          message: def?.desc || '',
        });
      }
    });
    primed.current = true;
  }, [
    bookings, posterBookings, postedJobs,
    earningsTotal, streakDays, verified, avatarUrl, bio, skills,
    reviews, referrals, badges, unlockBadge, showToast,
  ]);
}
