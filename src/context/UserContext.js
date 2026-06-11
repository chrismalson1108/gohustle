import React, { createContext, useContext, useReducer } from 'react';
import { BADGE_DEFS, LEVELS } from '../data/mockData';

// TODO: persist with AsyncStorage

const INITIAL = {
  name: 'Alex',
  avatarInitial: 'A',
  role: 'earner', // 'earner' | 'poster'
  rating: 4.8,
  reviewCount: 9,
  memberSince: 'May 2026',

  xp: 340,
  streakDays: 5,

  earningsToday: 45,
  earningsWeek: 210,
  earningsTotal: 1340,

  weeklyEarningGoal: 300,
  weeklyJobsGoal: 5,
  weeklyJobsDone: 3,

  badges: {
    firstHustle: { unlocked: true },
    onFire:      { unlocked: true },
    bigEarner:   { unlocked: false },
    topRated:    { unlocked: false },
    speedDemon:  { unlocked: false },
  },

  challenges: [
    {
      id: 'c1', icon: '🎯', title: 'Apply to 3 Gigs',
      description: 'Apply to 3 gigs today', type: 'daily',
      progress: 1, target: 3, xpReward: 50, expiresLabel: 'Ends tonight',
    },
    {
      id: 'c2', icon: '💵', title: 'Earn $100 This Week',
      description: 'Complete gigs totaling $100', type: 'weekly',
      progress: 45, target: 100, xpReward: 150, expiresLabel: '3 days left',
    },
    {
      id: 'c3', icon: '💻', title: 'Tech Whiz',
      description: 'Complete a Tech Help gig', type: 'weekly',
      progress: 0, target: 1, xpReward: 75, expiresLabel: '5 days left',
    },
  ],

  pendingToast: null,
};

function getLevelInfo(xp) {
  let current = LEVELS[0];
  for (const l of LEVELS) {
    if (xp >= l.minXP) current = l;
  }
  const nextIdx = LEVELS.findIndex(l => l.level === current.level) + 1;
  const next = LEVELS[nextIdx] || current;
  const progress = current === next
    ? 1
    : (xp - current.minXP) / (next.minXP - current.minXP);
  return { current, next, progress };
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_ROLE':
      return { ...state, role: action.role };

    case 'ADD_XP':
      return { ...state, xp: state.xp + action.amount };

    case 'UPDATE_CHALLENGE': {
      const challenges = state.challenges.map(c =>
        c.id === action.id
          ? { ...c, progress: Math.min(c.target, c.progress + action.delta) }
          : c
      );
      return { ...state, challenges };
    }

    case 'SET_GOALS':
      return {
        ...state,
        weeklyEarningGoal: action.earningGoal,
        weeklyJobsGoal: action.jobsGoal,
      };

    case 'RECORD_APPLY':
      return {
        ...state,
        weeklyJobsDone: state.weeklyJobsDone + 1,
        earningsToday: state.earningsToday + (action.amount || 0),
        earningsWeek: state.earningsWeek + (action.amount || 0),
        earningsTotal: state.earningsTotal + (action.amount || 0),
      };

    case 'SHOW_TOAST':
      return { ...state, pendingToast: action.toast };

    case 'DISMISS_TOAST':
      return { ...state, pendingToast: null };

    case 'UNLOCK_BADGE':
      if (state.badges[action.key]?.unlocked) return state;
      return {
        ...state,
        badges: { ...state.badges, [action.key]: { unlocked: true } },
        pendingToast: {
          icon: BADGE_DEFS[action.key]?.icon || '🏆',
          title: 'Badge Unlocked!',
          message: BADGE_DEFS[action.key]?.label || 'Achievement',
        },
      };

    default:
      return state;
  }
}

const UserContext = createContext(null);

export function UserProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const levelInfo = getLevelInfo(state.xp);

  return (
    <UserContext.Provider value={{
      ...state,
      levelInfo,
      setRole:          (role)                  => dispatch({ type: 'SET_ROLE', role }),
      addXP:            (amount)                => dispatch({ type: 'ADD_XP', amount }),
      updateChallenge:  (id, delta)             => dispatch({ type: 'UPDATE_CHALLENGE', id, delta }),
      setGoals:         (earningGoal, jobsGoal) => dispatch({ type: 'SET_GOALS', earningGoal, jobsGoal }),
      recordApply:      (amount)                => dispatch({ type: 'RECORD_APPLY', amount }),
      showToast:        (toast)                 => dispatch({ type: 'SHOW_TOAST', toast }),
      dismissToast:     ()                      => dispatch({ type: 'DISMISS_TOAST' }),
      unlockBadge:      (key)                   => dispatch({ type: 'UNLOCK_BADGE', key }),
    }}>
      {children}
    </UserContext.Provider>
  );
}

export const useUser = () => useContext(UserContext);
