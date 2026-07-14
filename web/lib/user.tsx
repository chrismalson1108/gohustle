"use client";

import React, { createContext, useContext, useReducer, useEffect, useRef, useState } from "react";
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
  city: string | null;
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
  city: null,
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
    city: (p.city as string) || null,
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
  profileStatus: "loading" | "ready" | "error";
  retryProfile: () => void;
  addXP: (amount: number) => void;
  updateChallenge: (id: string, delta: number) => void;
  unlockBadge: (key: string) => void;
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
  // 'loading' until real data (cache or server) arrives; 'error' only after all
  // retries fail with no cache. Screens must never render DEFAULT_STATE as if it
  // were the user's data — that's how a real account looked like a blank
  // "Hustler" account whenever one fetch failed after an OAuth redirect.
  const [profileStatus, setProfileStatus] = useState<"loading" | "ready" | "error">("loading");
  const activeUserId = useRef<string | null>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatch = useRef<Record<string, unknown>>({});

  useEffect(() => {
    activeUserId.current = user?.id ?? null;
    if (!user) return;
    const uid = user.id;
    setProfileStatus("loading");
    loadProfile(uid);
    return () => {
      // On sign-out / account switch, flush any pending debounced profile write for
      // THIS user before teardown — otherwise the last ~2s of XP/earnings is either
      // lost or fires later against the wrong (or no) session. Sign-out is optimistic
      // and revokes the token in the background, so the token is still valid here.
      if (syncTimer.current) {
        clearTimeout(syncTimer.current);
        syncTimer.current = null;
        const patch = pendingPatch.current;
        pendingPatch.current = {};
        if (patch && Object.keys(patch).length) {
          supabase
            .from("profiles")
            .update(patch)
            .eq("id", uid)
            .then(({ error }) => {
              if (error) console.warn("Profile sync flush error:", error.message);
            });
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("profile fetch timed out")), ms),
      ),
    ]);

  const fetchProfileBundle = async (userId: string) => {
    const [profileRes, badgesRes, challengesRes] = await Promise.all([
      supabase.rpc("my_profile"), // owner's full row (private columns are revoked from direct reads)
      supabase.from("badges").select("*").eq("user_id", userId),
      supabase.from("user_challenges").select("*").eq("user_id", userId),
    ]);
    // Surface failures instead of silently returning null: my_profile is
    // authenticated-only, so a fetch fired before the session token is attached
    // (common right after the OAuth callback) errors or returns null jsonb.
    if (profileRes.error) throw profileRes.error;
    const profile = profileRes.data as DbProfile | null;
    if (!profile || !(profile as { id?: string }).id) throw new Error("profile not available yet");
    return { profile, badges: badgesRes.data || [], challenges: challengesRes.data || [] };
  };

  // Retry with backoff: a transient failure (post-OAuth token race, flaky
  // network) self-heals invisibly; only a persistent failure with no cached
  // copy surfaces an error state. Never strand the user on placeholder data.
  const RETRY_DELAYS_MS = [0, 1500, 4000];
  const loadProfile = async (userId: string) => {
    const cacheKey = `profile_${userId}`;
    const cached = await cacheGet<UserState>(cacheKey);
    if (cached && activeUserId.current === userId) {
      dispatch({ type: "LOAD_PROFILE", profile: cached });
      setProfileStatus("ready");
    }
    for (const delay of RETRY_DELAYS_MS) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (activeUserId.current !== userId) return; // signed out / switched accounts
      try {
        const { profile, badges, challenges } = await withTimeout(fetchProfileBundle(userId), 10000);
        if (activeUserId.current !== userId) return;
        const profileState = dbToState(profile, badges, challenges);
        dispatch({ type: "LOAD_PROFILE", profile: profileState });
        cacheSet(cacheKey, profileState);
        setProfileStatus("ready");
        return;
      } catch {
        // fall through to the next retry
      }
    }
    if (activeUserId.current !== userId) return;
    setProfileStatus(cached ? "ready" : "error");
  };

  const retryProfile = () => {
    if (!user) return;
    setProfileStatus("loading");
    loadProfile(user.id);
  };

  // Merge pending patches into one object so a later debounced call (e.g. earnings)
  // doesn't clobber an earlier one (e.g. xp) — otherwise two rapid syncs would
  // drop the first write entirely.
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

  // Discrete, user-intent settings (role, goals, work status, availability) must
  // persist NOW — a 2s debounce could drop them if the user navigates/refreshes in
  // the window. Flush immediately, folding in any pending xp/earnings patch so we
  // don't clobber a debounced write that hasn't fired yet.
  const syncProfileNow = (patch: Record<string, unknown>) => {
    if (!user) return;
    const toSend = { ...pendingPatch.current, ...patch };
    pendingPatch.current = {};
    if (syncTimer.current) clearTimeout(syncTimer.current);
    supabase
      .from("profiles")
      .update(toSend)
      .eq("id", user.id)
      .then(({ error }) => {
        if (error) console.warn("Profile sync error:", error.message);
      });
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

  const setRole = (role: UserState["role"]) => {
    dispatch({ type: "SET_ROLE", role });
    syncProfileNow({ role });
  };

  const setGoals = (earningGoal: number, jobsGoal: number) => {
    dispatch({ type: "SET_GOALS", earningGoal, jobsGoal });
    syncProfileNow({ weekly_earning_goal: earningGoal, weekly_jobs_goal: jobsGoal });
  };

  const setMonthlyGoal = (goal: number) => {
    dispatch({ type: "LOAD_PROFILE", profile: { monthlyEarningGoal: goal } });
    syncProfileNow({ monthly_earning_goal: goal });
  };

  const setWorkStatus = (status: UserState["workStatus"], note: string | null = null) => {
    dispatch({ type: "LOAD_PROFILE", profile: { workStatus: status, workStatusNote: note } });
    syncProfileNow({ work_status: status, work_status_note: note });
  };

  const setAvailability = (windows: UserState["availability"]) => {
    dispatch({ type: "LOAD_PROFILE", profile: { availability: windows } });
    syncProfileNow({ availability: windows });
  };

  const refreshProfile = async () => {
    if (!user) return;
    try {
      const { profile, badges, challenges } = await withTimeout(fetchProfileBundle(user.id), 10000);
      const profileState = dbToState(profile, badges, challenges);
      dispatch({ type: "LOAD_PROFILE", profile: profileState });
      cacheSet(`profile_${user.id}`, profileState);
      setProfileStatus("ready");
    } catch {
      // keep showing the current data; callers surface their own errors
    }
  };

  const showToast = (toast: Toast) => dispatch({ type: "SHOW_TOAST", toast });
  const dismissToast = () => dispatch({ type: "DISMISS_TOAST" });

  const levelInfo = getLevelInfo(state.xp);

  return (
    <UserContext.Provider
      value={{
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
