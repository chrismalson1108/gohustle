"use client";

import React, { createContext, useContext, useReducer, useEffect, useRef } from "react";
import { getLevelInfo } from "@gohustlr/shared";
import { supabase } from "./supabaseClient";
import { cacheGet, cacheSet } from "./cache";
import { useAuth } from "./auth";
import type { Toast } from "./types";

const SYNC_DEBOUNCE_MS = 2000;

export interface Challenge {
  id: string;
  icon: string;
  ion: string;
  title: string;
  description: string;
  type: "daily" | "weekly";
  progress: number;
  target: number;
  xpReward: number;
}

export interface UserState {
  name: string;
  avatarInitial: string;
  avatarUrl: string | null;
  role: "earner" | "poster" | "both";
  rating: number;
  reviewCount: number;
  memberSince: string;
  xp: number;
  streakDays: number;
  earningsToday: number;
  earningsWeek: number;
  earningsTotal: number;
  weeklyEarningGoal: number;
  weeklyJobsGoal: number;
  weeklyJobsDone: number;
  monthlyEarningGoal: number;
  workStatus: "available" | "busy" | "away" | "offline";
  workStatusNote: string | null;
  availability: Array<{ day: number; start: string; end: string }>;
  // College identity
  school: string | null;
  schoolDomain: string | null;
  major: string | null;
  degreeType: string | null;
  classStanding: string | null;
  gradYear: number | null;
  studentStatus: string;
  studentVerified: boolean;
  skills: string[];
  badges: Record<string, { unlocked: boolean }>;
  challenges: Challenge[];
  pendingToast: Toast | null;
}

const DEFAULT_STATE: UserState = {
  name: "Hustler",
  avatarInitial: "H",
  avatarUrl: null,
  role: "earner",
  rating: 5.0,
  reviewCount: 0,
  memberSince: "",
  xp: 0,
  streakDays: 0,
  earningsToday: 0,
  earningsWeek: 0,
  earningsTotal: 0,
  weeklyEarningGoal: 300,
  weeklyJobsGoal: 5,
  weeklyJobsDone: 0,
  monthlyEarningGoal: 1000,
  workStatus: "available",
  workStatusNote: null,
  availability: [],
  school: null,
  schoolDomain: null,
  major: null,
  degreeType: null,
  classStanding: null,
  gradYear: null,
  studentStatus: "none",
  studentVerified: false,
  skills: [],
  badges: {
    firstHustle: { unlocked: false },
    onFire: { unlocked: false },
    bigEarner: { unlocked: false },
    topRated: { unlocked: false },
    speedDemon: { unlocked: false },
  },
  challenges: [
    { id: "c1", icon: "🎯", ion: "locate", title: "Apply to 3 Gigs", description: "Apply to 3 gigs today", type: "daily", progress: 0, target: 3, xpReward: 50 },
    { id: "c2", icon: "💵", ion: "cash", title: "Earn $100 This Week", description: "Complete gigs totaling $100", type: "weekly", progress: 0, target: 100, xpReward: 150 },
    { id: "c3", icon: "💻", ion: "laptop", title: "Tech Whiz", description: "Complete a Tech Help gig", type: "weekly", progress: 0, target: 1, xpReward: 75 },
  ],
  pendingToast: null,
};

type DbProfile = Record<string, unknown>;

function dbToState(
  profile: DbProfile,
  badges: Array<{ badge_key: string; unlocked: boolean }> = [],
  challenges: Array<{ challenge_id: string; progress: number }> = [],
): UserState {
  const badgeMap = { ...DEFAULT_STATE.badges };
  badges.forEach((b) => {
    if (badgeMap[b.badge_key] !== undefined) badgeMap[b.badge_key] = { unlocked: b.unlocked };
  });

  const challengeMap: Record<string, { progress: number }> = {};
  challenges.forEach((c) => {
    challengeMap[c.challenge_id] = c;
  });

  const mergedChallenges = DEFAULT_STATE.challenges.map((c) => ({
    ...c,
    progress: challengeMap[c.id]?.progress ?? c.progress,
  }));

  const p = profile as Record<string, string | number | null | undefined>;
  return {
    name: (p.name as string) || "Hustler",
    avatarInitial:
      (p.avatar_initial as string) || (p.name as string)?.charAt(0)?.toUpperCase() || "H",
    avatarUrl: (p.avatar_url as string) || null,
    role: ((p.role as string) || "earner") as UserState["role"],
    rating: Number(p.rating) || 5.0,
    reviewCount: Number(p.review_count) || 0,
    memberSince: (p.member_since as string) || "",
    xp: Number(p.xp) || 0,
    streakDays: Number(p.streak_days) || 0,
    earningsToday: Number(p.earnings_today) || 0,
    earningsWeek: Number(p.earnings_week) || 0,
    earningsTotal: Number(p.earnings_total) || 0,
    weeklyEarningGoal: Number(p.weekly_earning_goal) || 300,
    weeklyJobsGoal: Number(p.weekly_jobs_goal) || 5,
    weeklyJobsDone: Number(p.weekly_jobs_done) || 0,
    monthlyEarningGoal: Number(p.monthly_earning_goal) || 1000,
    workStatus: (((p.work_status as string) || "available") as UserState["workStatus"]),
    workStatusNote: (p.work_status_note as string) || null,
    availability: Array.isArray((profile as Record<string, unknown>).availability)
      ? ((profile as Record<string, unknown>).availability as UserState["availability"])
      : [],
    school: (p.school as string) || null,
    schoolDomain: (p.school_domain as string) || null,
    major: (p.major as string) || null,
    degreeType: (p.degree_type as string) || null,
    classStanding: (p.class_standing as string) || null,
    gradYear: (p.grad_year as number) ?? null,
    studentStatus: (p.student_status as string) || "none",
    studentVerified: Boolean(p.student_verified),
    skills: Array.isArray((profile as Record<string, unknown>).skills)
      ? ((profile as Record<string, unknown>).skills as string[])
      : [],
    badges: badgeMap,
    challenges: mergedChallenges,
    pendingToast: null,
  };
}

type Action =
  | { type: "LOAD_PROFILE"; profile: Partial<UserState> }
  | { type: "SET_ROLE"; role: UserState["role"] }
  | { type: "ADD_XP"; amount: number }
  | { type: "UPDATE_CHALLENGE"; id: string; delta: number }
  | { type: "UNLOCK_BADGE"; key: string }
  | { type: "RECORD_APPLY"; amount: number }
  | { type: "SET_GOALS"; earningGoal: number; jobsGoal: number }
  | { type: "SHOW_TOAST"; toast: Toast }
  | { type: "DISMISS_TOAST" };

function reducer(state: UserState, action: Action): UserState {
  switch (action.type) {
    case "LOAD_PROFILE":
      return { ...state, ...action.profile };
    case "SET_ROLE":
      return { ...state, role: action.role };
    case "ADD_XP":
      return { ...state, xp: state.xp + action.amount };
    case "UPDATE_CHALLENGE":
      return {
        ...state,
        challenges: state.challenges.map((c) =>
          c.id === action.id ? { ...c, progress: Math.min(c.target, c.progress + action.delta) } : c,
        ),
      };
    case "UNLOCK_BADGE":
      return { ...state, badges: { ...state.badges, [action.key]: { unlocked: true } } };
    case "RECORD_APPLY":
      return {
        ...state,
        earningsToday: state.earningsToday + action.amount,
        earningsWeek: state.earningsWeek + action.amount,
        earningsTotal: state.earningsTotal + action.amount,
        weeklyJobsDone: state.weeklyJobsDone + 1,
      };
    case "SET_GOALS":
      return { ...state, weeklyEarningGoal: action.earningGoal, weeklyJobsGoal: action.jobsGoal };
    case "SHOW_TOAST":
      return { ...state, pendingToast: action.toast };
    case "DISMISS_TOAST":
      return { ...state, pendingToast: null };
    default:
      return state;
  }
}

interface UserValue extends UserState {
  levelInfo: ReturnType<typeof getLevelInfo>;
  addXP: (amount: number) => void;
  updateChallenge: (id: string, delta: number) => void;
  unlockBadge: (key: string) => void;
  recordApply: (amount: number) => void;
  setRole: (role: UserState["role"]) => void;
  setGoals: (earningGoal: number, jobsGoal: number) => void;
  setMonthlyGoal: (goal: number) => void;
  setWorkStatus: (status: UserState["workStatus"], note?: string | null) => void;
  setAvailability: (windows: UserState["availability"]) => void;
  showToast: (toast: Toast) => void;
  dismissToast: () => void;
  refreshProfile: () => Promise<void>;
}

const UserContext = createContext<UserValue | null>(null);

export function UserProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [state, dispatch] = useReducer(reducer, DEFAULT_STATE);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatch = useRef<Record<string, unknown>>({});

  useEffect(() => {
    if (!user) return;
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const fetchProfileBundle = async (userId: string) => {
    const [{ data: profile }, { data: badges }, { data: challenges }] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", userId).single(),
      supabase.from("badges").select("*").eq("user_id", userId),
      supabase.from("user_challenges").select("*").eq("user_id", userId),
    ]);
    return { profile, badges, challenges };
  };

  const loadProfile = async () => {
    if (!user) return;
    const cacheKey = `profile_${user.id}`;
    const cached = await cacheGet<UserState>(cacheKey);
    if (cached) dispatch({ type: "LOAD_PROFILE", profile: cached });

    const { profile, badges, challenges } = await fetchProfileBundle(user.id);
    if (!profile) return;
    const profileState = dbToState(profile, badges || [], challenges || []);
    dispatch({ type: "LOAD_PROFILE", profile: profileState });
    cacheSet(cacheKey, profileState);
  };

  // Merge pending patches into one object so a later debounced call (e.g. earnings)
  // doesn't clobber an earlier one (e.g. xp) — otherwise rapid addXP + recordApply
  // would drop the XP write entirely.
  const scheduleSyncProfile = (patch: Record<string, unknown>) => {
    if (!user) return;
    pendingPatch.current = { ...pendingPatch.current, ...patch };
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      const toSend = pendingPatch.current;
      pendingPatch.current = {};
      supabase
        .from("profiles")
        .update(toSend)
        .eq("id", user.id)
        .then(({ error }) => {
          if (error) console.warn("Profile sync error:", error.message);
        });
    }, SYNC_DEBOUNCE_MS);
  };

  const addXP = (amount: number) => {
    dispatch({ type: "ADD_XP", amount });
    scheduleSyncProfile({ xp: state.xp + amount });
  };

  const updateChallenge = (id: string, delta: number) => {
    dispatch({ type: "UPDATE_CHALLENGE", id, delta });
    if (!user) return;
    const c = state.challenges.find((x) => x.id === id);
    supabase
      .from("user_challenges")
      .upsert(
        { user_id: user.id, challenge_id: id, progress: (c?.progress || 0) + delta, target: c?.target || 1 },
        { onConflict: "user_id,challenge_id" },
      )
      .then(({ error }) => {
        if (error) console.warn("Challenge sync error:", error.message);
      });
  };

  const unlockBadge = (key: string) => {
    if (state.badges[key]?.unlocked) return;
    dispatch({ type: "UNLOCK_BADGE", key });
    if (!user) return;
    supabase
      .from("badges")
      .upsert(
        { user_id: user.id, badge_key: key, unlocked: true, unlocked_at: new Date().toISOString() },
        { onConflict: "user_id,badge_key" },
      )
      .then(({ error }) => {
        if (error) console.warn("Badge sync error:", error.message);
      });
  };

  const recordApply = (amount: number) => {
    dispatch({ type: "RECORD_APPLY", amount });
    scheduleSyncProfile({
      earnings_today: state.earningsToday + amount,
      earnings_week: state.earningsWeek + amount,
      earnings_total: state.earningsTotal + amount,
      weekly_jobs_done: state.weeklyJobsDone + 1,
    });
  };

  const setRole = (role: UserState["role"]) => {
    dispatch({ type: "SET_ROLE", role });
    scheduleSyncProfile({ role });
  };

  const setGoals = (earningGoal: number, jobsGoal: number) => {
    dispatch({ type: "SET_GOALS", earningGoal, jobsGoal });
    scheduleSyncProfile({ weekly_earning_goal: earningGoal, weekly_jobs_goal: jobsGoal });
  };

  const setMonthlyGoal = (goal: number) => {
    dispatch({ type: "LOAD_PROFILE", profile: { monthlyEarningGoal: goal } });
    scheduleSyncProfile({ monthly_earning_goal: goal });
  };

  const setWorkStatus = (status: UserState["workStatus"], note: string | null = null) => {
    dispatch({ type: "LOAD_PROFILE", profile: { workStatus: status, workStatusNote: note } });
    scheduleSyncProfile({ work_status: status, work_status_note: note });
  };

  const setAvailability = (windows: UserState["availability"]) => {
    dispatch({ type: "LOAD_PROFILE", profile: { availability: windows } });
    scheduleSyncProfile({ availability: windows });
  };

  const refreshProfile = async () => {
    if (!user) return;
    const cacheKey = `profile_${user.id}`;
    const { profile, badges, challenges } = await fetchProfileBundle(user.id);
    if (!profile) return;
    const profileState = dbToState(profile, badges || [], challenges || []);
    dispatch({ type: "LOAD_PROFILE", profile: profileState });
    cacheSet(cacheKey, profileState);
  };

  const showToast = (toast: Toast) => dispatch({ type: "SHOW_TOAST", toast });
  const dismissToast = () => dispatch({ type: "DISMISS_TOAST" });

  const levelInfo = getLevelInfo(state.xp);

  return (
    <UserContext.Provider
      value={{
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
      }}
    >
      {children}
    </UserContext.Provider>
  );
}

export const useUser = (): UserValue => {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error("useUser must be used within UserProvider");
  return ctx;
};
