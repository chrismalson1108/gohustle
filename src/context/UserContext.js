import React, { createContext, useContext, useReducer, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { cacheGet, cacheSet } from '../lib/cache';
import { useAuth } from './AuthContext';
import { BADGE_DEFS, LEVELS } from '../data/mockData';

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
  school: null,
  schoolDomain: null,
  major: null,
  degreeType: null,
  classStanding: null,
  gradYear: null,
  studentStatus: 'none',
  studentVerified: false,
  badges: {
    firstHustle: { unlocked: false },
    onFire:      { unlocked: false },
    bigEarner:   { unlocked: false },
    topRated:    { unlocked: false },
    speedDemon:  { unlocked: false },
  },
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
    if (badgeMap[b.badge_key] !== undefined) badgeMap[b.badge_key] = { unlocked: b.unlocked };
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

    case 'RECORD_APPLY':
      // No earnings credit at apply time — only the weekly counter advances.
      return { ...state, weeklyJobsDone: state.weeklyJobsDone + 1 };

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
  const syncTimer = useRef(null);
  const pendingPatch = useRef({});

  useEffect(() => {
    if (!user) return;
    loadProfile();
  }, [user]);

  const loadProfile = async () => {
    const cacheKey = `profile_${user.id}`;

    // 1. Show cached profile instantly
    const cached = await cacheGet(cacheKey);
    if (cached) dispatch({ type: 'LOAD_PROFILE', profile: cached });

    // 2. Fetch fresh from Supabase
    const [{ data: profile }, { data: badges }, { data: challenges }] = await Promise.all([
      supabase.rpc('my_profile'),
      supabase.from('badges').select('*').eq('user_id', user.id),
      supabase.from('user_challenges').select('*').eq('user_id', user.id),
    ]);

    if (!profile) return;
    const profileState = dbToState(profile, badges || [], challenges || []);
    dispatch({ type: 'LOAD_PROFILE', profile: profileState });
    cacheSet(cacheKey, profileState);
  };

  // Debounced sync to Supabase so rapid XP taps don't flood the DB. Patches are
  // MERGED into a pending object so two calls in the same tick (e.g. addXP +
  // recordApply) don't clobber each other's fields.
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
    scheduleSyncProfile({ xp: state.xp + amount });
  };

  const updateChallenge = (id, delta) => {
    dispatch({ type: 'UPDATE_CHALLENGE', id, delta });
    if (!user) return;
    supabase.from('user_challenges')
      .upsert({ user_id: user.id, challenge_id: id, progress: (state.challenges.find(c => c.id === id)?.progress || 0) + delta, target: state.challenges.find(c => c.id === id)?.target || 1 }, { onConflict: 'user_id,challenge_id' })
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

  const recordApply = () => {
    // Booking/applying advances the weekly gamification counter only — real
    // earnings are credited at settlement (Stripe capture), never at apply time.
    dispatch({ type: 'RECORD_APPLY' });
    scheduleSyncProfile({ weekly_jobs_done: state.weeklyJobsDone + 1 });
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
    const cacheKey = `profile_${user.id}`;
    const [{ data: profile }, { data: badges }, { data: challenges }] = await Promise.all([
      supabase.rpc('my_profile'),
      supabase.from('badges').select('*').eq('user_id', user.id),
      supabase.from('user_challenges').select('*').eq('user_id', user.id),
    ]);
    if (!profile) return;
    const profileState = dbToState(profile, badges || [], challenges || []);
    dispatch({ type: 'LOAD_PROFILE', profile: profileState });
    cacheSet(cacheKey, profileState);
  };

  const showToast  = (toast) => dispatch({ type: 'SHOW_TOAST',   toast });
  const dismissToast = ()    => dispatch({ type: 'DISMISS_TOAST' });

  const levelInfo = getLevelInfo(state.xp);

  return (
    <UserContext.Provider value={{
      ...state,
      levelInfo,
      addXP,
      updateChallenge,
      unlockBadge,
      recordApply,
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
