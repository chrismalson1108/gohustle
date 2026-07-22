import React, { createContext, useContext, useReducer, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { cacheGet, cacheSet } from '../lib/cache';
import { useAuth } from './AuthContext';
import { BADGE_DEFS, LEVELS } from '../data/mockData';
import { emptyBadgeMap } from '../../shared/badges.js';

const UserContext = createContext(null);

const PROFILE_CACHE_KEY = 'profile_v1';
const SYNC_DEBOUNCE_MS  = 2000;

function getLevelInfo(xp) {
  let current = LEVELS[0];
  let next = LEVELS[1];
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (xp >= LEVELS[i].minXP) {
      current = LEVELS[i];
      next = LEVELS[i + 1] || null;
      break;
    }
  }
  const progress = next
    ? (xp - current.minXP) / (next.minXP - current.minXP)
    : 1;
  return { current, next, progress };
}

const DEFAULT_STATE = {
  name: 'Hustler',
  avatarInitial: 'H',
  avatarUrl: null,
  role: 'earner',
  rating: 5.0,
  reviewCount: 0,
  memberSince: '',
  xp: 0,
  streakDays: 0,
  earningsToday: 0,
  earningsWeek: 0,
  earningsTotal: 0,
  weeklyEarningGoal: 300,
  weeklyJobsGoal: 5,
  weeklyJobsDone: 0,
  monthlyEarningGoal: 1000,
  workStatus: 'available',
  workStatusNote: null,
  availability: [],
  skills: [],
  city: null,
  bio: null,
  verified: false,
  school: null,
  schoolDomain: null,
  major: null,
  degreeType: null,
  classStanding: null,
  gradYear: null,
  studentStatus: 'none',
  studentVerified: false,
  // Derived from the catalogue, never hand-listed — a hardcoded subset silently
  // discarded every badge added later, so they re-unlocked (and re-toasted)
  // on every single load.
  badges: emptyBadgeMap(),
  challenges: [
    { id: 'c1', icon: '🎯', ion: 'locate', title: 'Apply to 3 Gigs',     description: 'Apply to 3 gigs today',        type: 'daily',  progress: 0, target: 3,   xpReward: 50  },
    { id: 'c2', icon: '💵', ion: 'cash',   title: 'Earn $100 This Week', description: 'Complete gigs totaling $100', type: 'weekly', progress: 0, target: 100, xpReward: 150 },
    { id: 'c3', icon: '💻', ion: 'laptop', title: 'Tech Whiz',           description: 'Complete a Tech Help gig',    type: 'weekly', progress: 0, target: 1,   xpReward: 75  },
  ],
  pendingToast: null,
};

function dbToState(profile, badges = [], challenges = []) {
  const badgeMap = { ...DEFAULT_STATE.badges };
  badges.forEach(b => {
    // Keep rows for retired badge keys out of state, but accept every key the
    // current catalogue knows about.
    if (b?.badge_key && badgeMap[b.badge_key] !== undefined) {
      badgeMap[b.badge_key] = { unlocked: !!b.unlocked };
    }
  });

  const challengeMap = {};
  challenges.forEach(c => { challengeMap[c.challenge_id] = c; });

  const mergedChallenges = DEFAULT_STATE.challenges.map(c => ({
    ...c,
    progress: challengeMap[c.id]?.progress ?? c.progress,
  }));

  return {
    name: profile.name || 'Hustler',
    avatarInitial: profile.avatar_initial || profile.name?.charAt(0).toUpperCase() || 'H',
    avatarUrl: profile.avatar_url || null,
    role: profile.role || 'earner',
    rating: Number(profile.rating) || 5.0,
    reviewCount: profile.review_count || 0,
    memberSince: profile.member_since || '',
    xp: profile.xp || 0,
    streakDays: profile.streak_days || 0,
    earningsToday: Number(profile.earnings_today) || 0,
    earningsWeek: Number(profile.earnings_week) || 0,
    earningsTotal: Number(profile.earnings_total) || 0,
    weeklyEarningGoal: Number(profile.weekly_earning_goal) || 300,
    weeklyJobsGoal: profile.weekly_jobs_goal || 5,
    weeklyJobsDone: profile.weekly_jobs_done || 0,
    monthlyEarningGoal: Number(profile.monthly_earning_goal) || 1000,
    workStatus: profile.work_status || 'available',
    workStatusNote: profile.work_status_note || null,
    availability: Array.isArray(profile.availability) ? profile.availability : [],
    skills: Array.isArray(profile.skills) ? profile.skills : [],
    city: profile.city || null,
    // Consumed by the badge rules (allStar needs bio, idVerified needs verified).
    bio: profile.bio || null,
    verified: !!profile.verified,
    school: profile.school || null,
    schoolDomain: profile.school_domain || null,
    major: profile.major || null,
    degreeType: profile.degree_type || null,
    classStanding: profile.class_standing || null,
    gradYear: profile.grad_year || null,
    studentStatus: profile.student_status || 'none',
    studentVerified: profile.student_verified || false,
    badges: badgeMap,
    challenges: mergedChallenges,
    pendingToast: null,
  };
}

function reducer(state, action) {
  switch (action.type) {
    case 'LOAD_PROFILE':
      return { ...state, ...action.profile };

    case 'SET_ROLE':
      return { ...state, role: action.role };

    case 'ADD_XP': {
      const xp = state.xp + action.amount;
      return { ...state, xp };
    }

    case 'UPDATE_CHALLENGE': {
      const challenges = state.challenges.map(c => {
        if (c.id !== action.id) return c;
        const progress = Math.min(c.target, c.progress + action.delta);
        return { ...c, progress };
      });
      return { ...state, challenges };
    }

    case 'UNLOCK_BADGE':
      return {
        ...state,
        badges: { ...state.badges, [action.key]: { unlocked: true } },
      };

    case 'SET_GOALS':
      return { ...state, weeklyEarningGoal: action.earningGoal, weeklyJobsGoal: action.jobsGoal };

    case 'SHOW_TOAST':
      return { ...state, pendingToast: action.toast };

    case 'DISMISS_TOAST':
      return { ...state, pendingToast: null };

    default:
      return state;
  }
}

export function UserProvider({ children }) {
  const { user } = useAuth();
  const [state, dispatch] = useReducer(reducer, DEFAULT_STATE);
  // 'loading' until real data (cache or server) arrives; 'error' only after all
  // retries fail with no cache. Screens must never render DEFAULT_STATE as if it
  // were the user's data — that's how a real account looked like a blank
  // "Hustler" account whenever one fetch failed after an OAuth redirect.
  const [profileStatus, setProfileStatus] = useState('loading');
  const activeUserId = useRef(null);
  const syncTimer = useRef(null);
  const pendingPatch = useRef({});
  // Authoritative accumulators for the debounced/optimistic writes below. The DB
  // patches must NOT be computed from render-scope `state` (a stale closure): two
  // increments in the same tick would both read the same base and the later merge
  // would drop the first. These refs mirror state but accumulate deltas immediately,
  // and an effect reseeds them whenever fresh profile data lands.
  const xpRef = useRef(state.xp);
  const challengeProgressRef = useRef({});
  useEffect(() => { xpRef.current = state.xp; }, [state.xp]);
  useEffect(() => {
    const m = {};
    state.challenges.forEach(c => { m[c.id] = c.progress; });
    challengeProgressRef.current = m;
  }, [state.challenges]);

  useEffect(() => {
    activeUserId.current = user?.id ?? null;
    if (!user) return;
    setProfileStatus('loading');
    loadProfile(user.id);
  }, [user?.id]);

  const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('profile fetch timed out')), ms)),
  ]);

  const fetchProfileBundle = async (userId) => {
    const [profileRes, badgesRes, challengesRes] = await Promise.all([
      supabase.rpc('my_profile'),
      supabase.from('badges').select('*').eq('user_id', userId),
      supabase.from('user_challenges').select('*').eq('user_id', userId),
    ]);
    // Surface failures instead of silently returning null: my_profile is
    // authenticated-only, so a fetch fired before the session token is attached
    // (common right after an OAuth sign-in) errors or returns null jsonb.
    if (profileRes.error) throw profileRes.error;
    const profile = profileRes.data;
    if (!profile || !profile.id) throw new Error('profile not available yet');
    return { profile, badges: badgesRes.data || [], challenges: challengesRes.data || [] };
  };

  // Retry with backoff: a transient failure (post-OAuth token race, flaky
  // network) self-heals invisibly; only a persistent failure with no cached
  // copy surfaces an error state. Never strand the user on placeholder data.
  const RETRY_DELAYS_MS = [0, 1500, 4000];
  const loadProfile = async (userId) => {
    const cacheKey = `profile_${userId}`;
    const cached = await cacheGet(cacheKey);
    if (cached && activeUserId.current === userId) {
      dispatch({ type: 'LOAD_PROFILE', profile: cached });
      setProfileStatus('ready');
    }
    for (const delay of RETRY_DELAYS_MS) {
      if (delay) await new Promise(r => setTimeout(r, delay));
      if (activeUserId.current !== userId) return; // signed out / switched accounts
      try {
        const { profile, badges, challenges } = await withTimeout(fetchProfileBundle(userId), 10000);
        if (activeUserId.current !== userId) return;
        const profileState = dbToState(profile, badges, challenges);
        dispatch({ type: 'LOAD_PROFILE', profile: profileState });
        cacheSet(cacheKey, profileState);
        setProfileStatus('ready');
        return;
      } catch (_) {
        // fall through to the next retry
      }
    }
    if (activeUserId.current !== userId) return;
    setProfileStatus(cached ? 'ready' : 'error');
  };

  const retryProfile = () => {
    if (!user) return;
    setProfileStatus('loading');
    loadProfile(user.id);
  };

  // Debounced sync to Supabase so rapid XP taps don't flood the DB. Patches are
  // MERGED into a pending object so two calls in the same tick (e.g. addXP +
  // setGoals) don't clobber each other's fields.
  const scheduleSyncProfile = (patch) => {
    if (!user) return;
    pendingPatch.current = { ...pendingPatch.current, ...patch };
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      const toSync = pendingPatch.current;
      pendingPatch.current = {};
      supabase.from('profiles').update(toSync).eq('id', user.id)
        .then(({ error }) => { if (error) console.warn('Profile sync error:', error.message); });
    }, SYNC_DEBOUNCE_MS);
  };

  const addXP = (amount) => {
    dispatch({ type: 'ADD_XP', amount });
    // Accumulate on the ref, not on stale state.xp, so two addXP calls in one tick
    // (e.g. from a single completion flow) both land in the debounced DB write.
    xpRef.current += amount;
    scheduleSyncProfile({ xp: xpRef.current });
  };

  const updateChallenge = (id, delta) => {
    dispatch({ type: 'UPDATE_CHALLENGE', id, delta });
    if (!user) return;
    const chal = state.challenges.find(c => c.id === id);
    const target = chal?.target || 1;
    // Base off the ref (accumulates same-tick deltas) rather than stale state, and
    // clamp the same way the reducer does so the DB matches the UI.
    const base = challengeProgressRef.current[id] ?? (chal?.progress || 0);
    const next = Math.min(target, base + delta);
    challengeProgressRef.current[id] = next;
    supabase.from('user_challenges')
      .upsert({ user_id: user.id, challenge_id: id, progress: next, target }, { onConflict: 'user_id,challenge_id' })
      .then(({ error }) => { if (error) console.warn('Challenge sync error:', error.message); });
  };

  const unlockBadge = (key) => {
    if (state.badges[key]?.unlocked) return;
    dispatch({ type: 'UNLOCK_BADGE', key });
    if (!user) return;
    supabase.from('badges')
      .upsert({ user_id: user.id, badge_key: key, unlocked: true, unlocked_at: new Date().toISOString() }, { onConflict: 'user_id,badge_key' })
      .then(({ error }) => { if (error) console.warn('Badge sync error:', error.message); });
  };

  const setRole = (role) => {
    dispatch({ type: 'SET_ROLE', role });
    scheduleSyncProfile({ role });
  };

  const setGoals = (earningGoal, jobsGoal) => {
    dispatch({ type: 'SET_GOALS', earningGoal, jobsGoal });
    scheduleSyncProfile({ weekly_earning_goal: earningGoal, weekly_jobs_goal: jobsGoal });
  };

  // Discrete settings — write immediately (not debounced) so they can't be
  // clobbered by a pending debounced sync.
  const writeProfile = (patch) => {
    if (user) {
      supabase.from('profiles').update(patch).eq('id', user.id)
        .then(({ error }) => { if (error) console.warn('Profile write error:', error.message); });
    }
  };

  const setMonthlyGoal = (goal) => {
    dispatch({ type: 'LOAD_PROFILE', profile: { monthlyEarningGoal: goal } });
    writeProfile({ monthly_earning_goal: goal });
  };

  const setWorkStatus = (status, note = null) => {
    dispatch({ type: 'LOAD_PROFILE', profile: { workStatus: status, workStatusNote: note } });
    writeProfile({ work_status: status, work_status_note: note });
  };

  const setAvailability = (windows) => {
    dispatch({ type: 'LOAD_PROFILE', profile: { availability: windows } });
    writeProfile({ availability: windows });
  };

  const refreshProfile = async () => {
    if (!user) return;
    try {
      const { profile, badges, challenges } = await withTimeout(fetchProfileBundle(user.id), 10000);
      const profileState = dbToState(profile, badges, challenges);
      dispatch({ type: 'LOAD_PROFILE', profile: profileState });
      cacheSet(`profile_${user.id}`, profileState);
      setProfileStatus('ready');
    } catch (_) {
      // keep showing the current data; pull-to-refresh callers surface their own errors
    }
  };

  const showToast  = (toast) => dispatch({ type: 'SHOW_TOAST',   toast });
  const dismissToast = ()    => dispatch({ type: 'DISMISS_TOAST' });

  const levelInfo = getLevelInfo(state.xp);

  return (
    <UserContext.Provider value={{
      ...state,
      levelInfo,
      profileStatus,
      retryProfile,
      addXP,
      updateChallenge,
      unlockBadge,
      setRole,
      setGoals,
      setMonthlyGoal,
      setWorkStatus,
      setAvailability,
      showToast,
      dismissToast,
      refreshProfile,
    }}>
      {children}
    </UserContext.Provider>
  );
}

export const useUser = () => useContext(UserContext);
