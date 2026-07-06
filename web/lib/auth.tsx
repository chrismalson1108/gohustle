"use client";

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import {
  supabase,
  purgePersistedSession,
  getRecoveryClient,
  SESSION_STORAGE_KEY,
} from "./supabaseClient";
import { cacheClearAll } from "./cache";
import { track } from "./analytics";
import { checkNeedsAcceptance } from "./legal";
import { friendlyAuthError } from "./authErrors";

// True when a session blob is actually persisted in this browser. Used to tell a
// slow-refresh returning user (keep waiting) apart from a genuinely logged-out
// visitor (go to /login) when the initial getSession() times out.
function hasPersistedSession(): boolean {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return !!(parsed?.refresh_token || parsed?.access_token || parsed?.currentSession);
  } catch {
    return false;
  }
}

interface AuthValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  // False until the current session's onboarding/terms state has been loaded. The
  // (app) gate must wait on this before trusting onboardingDone/needsTermsAcceptance.
  onboardingResolved: boolean;
  authError: string | null;
  onboardingDone: boolean;
  pendingEmail: string | null;
  needsTermsAcceptance: boolean;
  markTermsAccepted: () => void;
  signIn: (email: string, password: string) => Promise<boolean>;
  signInWithGoogle: () => Promise<boolean>;
  signUp: (email: string, password: string, name: string, referralCode?: string) => Promise<boolean>;
  resetPassword: (email: string) => Promise<boolean>;
  resendConfirmation: (email?: string) => Promise<boolean>;
  clearPending: () => void;
  signOut: () => Promise<void>;
  clearError: () => void;
  markOnboardingDone: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [onboardingDone, setOnbDone] = useState(true);
  // Has the onboarding/terms state been LOADED for the current session yet? The
  // (app) gate must not trust the optimistic onboardingDone=true default for a
  // freshly-set session — otherwise a not-onboarded / terms-owing user flashes the
  // full app shell for a frame before being bounced. False until loadOnboarding
  // (or the signed-out branch) resolves.
  const [onbResolved, setOnbResolved] = useState(false);
  const [needsTerms, setNeedsTerms] = useState(false);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const purgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Any new auth attempt must cancel a pending sign-out purge, or the timer
  // would delete the new flow's PKCE code-verifier / freshly stored session.
  const cancelPendingPurge = () => {
    if (purgeTimer.current) {
      clearTimeout(purgeTimer.current);
      purgeTimer.current = null;
    }
  };

  useEffect(() => {
    let cancelled = false;

    // Hard ceiling: even if getSession hangs AND no auth event ever fires (dead
    // network), never trap the app on the spinner forever.
    const hardTimer = setTimeout(() => {
      if (!cancelled) {
        setOnbResolved(true);
        setLoading(false);
      }
    }, 20000);

    // 1. Resolve the initial session. supabase-js can stall on a slow ?code
    //    exchange or a contended auth lock, so we time the read out and never
    //    leave `loading` true forever (that would freeze the app on the spinner).
    //    We only resolve the SESSION here; the profile/onboarding row is loaded by
    //    the effect below (keyed on the user id), never inside the auth callback.
    (async () => {
      try {
        const {
          data: { session },
        } = await Promise.race([
          supabase.auth.getSession(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("auth init timed out")), 8000),
          ),
        ]);
        if (cancelled) return;
        setSession(session);
        // No user → nothing to load, release the gate now. With a user, the
        // onboarding effect below releases it once the profile row resolves, so a
        // not-yet-onboarded user never flashes into the app on placeholder state.
        if (!session?.user) {
          setOnbResolved(true);
          setLoading(false);
        }
      } catch (err) {
        console.error("Auth init failed/timed out:", err);
        if (cancelled) return;
        // A genuinely logged-out visitor (no stored session) should reach /login
        // immediately. But a RETURNING user with a valid persisted session whose
        // refresh merely ran long must NOT be dumped on the sign-in form — keep the
        // spinner and let onAuthStateChange (TOKEN_REFRESHED / SIGNED_IN when the
        // refresh lands, or SIGNED_OUT if the token is truly dead) resolve it. The
        // hardTimer above is the ultimate backstop against an infinite spinner.
        if (!hasPersistedSession()) {
          setOnbResolved(true);
          setLoading(false);
        }
      }
    })();

    // 2. React to auth changes. CRITICAL: this callback MUST stay synchronous and
    //    never await a Supabase data call. supabase-js emits some events (a tab
    //    refocus SIGNED_IN, a TOKEN_REFRESHED) from *inside* its auth lock and
    //    awaits every subscriber; awaiting getSession/PostgREST here re-enters the
    //    held lock and deadlocks the client permanently — every later data fetch
    //    hangs and the app renders a blank "guest" account until a manual reload
    //    (the exact OAuth sign-in bug this replaced). Profile/terms loading happens
    //    in the effect below, outside the lock. See supabase-js onAuthStateChange
    //    docs: "Do not use an async callback / do not call other Supabase functions
    //    directly inside it."
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next?.user) {
        setOnbDone(true);
        setNeedsTerms(false);
        setOnbResolved(true);
        setLoading(false);
      }
      // With a user, the keyed onboarding effect below owns onbResolved + loading.
    });

    return () => {
      cancelled = true;
      clearTimeout(hardTimer);
      subscription.unsubscribe();
    };
  }, []);

  // Load onboarding + legal-acceptance state whenever the signed-in user changes.
  // Runs OUTSIDE the auth-lock callback (a plain effect), so the PostgREST call it
  // makes can safely acquire the auth lock to attach the JWT. This is what keeps a
  // fresh OAuth / password sign-in from wedging the client. Releases the loading
  // gate once resolved so the (app) gate routes onboarded vs. not-onboarded users
  // correctly instead of flashing the app shell on default state.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    let cancelled = false;
    (async () => {
      // New user → onboarding/terms state is unknown; close the gate (spinner) until
      // it resolves so the app shell never renders on the stale default. Runs
      // synchronously before the first await, so the gate closes this tick.
      setOnbResolved(false);
      try {
        await loadOnboarding(uid);
      } finally {
        if (!cancelled) {
          setOnbResolved(true);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  const loadOnboarding = async (userId: string) => {
    const { data } = await supabase
      .from("profiles")
      .select("onboarding_done")
      .eq("id", userId)
      .maybeSingle();
    const done = data?.onboarding_done ?? false;
    setOnbDone(done);
    setNeedsTerms(done ? await checkNeedsAcceptance(userId) : false);
  };

  const markOnboardingDone = () => {
    setOnbDone(true);
    setNeedsTerms(false);
  };

  const markTermsAccepted = () => setNeedsTerms(false);

  const signIn: AuthValue["signIn"] = async (email, password) => {
    setAuthError(null);
    cancelPendingPurge();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      if (
        (error as { code?: string }).code === "email_not_confirmed" ||
        /email not confirmed/i.test(error.message)
      ) {
        setPendingEmail(email);
        setAuthError("Please confirm your email first — check your inbox for the link.");
        return false;
      }
      setAuthError(friendlyAuthError(error));
      return false;
    }
    // Set session + onboarding state synchronously from the result so the page can
    // redirect into the app without racing the async onAuthStateChange event
    // (which otherwise lets the auth gate see a stale null session and bounce back).
    if (data.session) {
      setSession(data.session);
      if (data.user) await loadOnboarding(data.user.id);
    }
    setPendingEmail(null);
    track("sign_in");
    return true;
  };

  const signInWithGoogle: AuthValue["signInWithGoogle"] = async () => {
    setAuthError(null);
    cancelPendingPurge();
    // OAuth (PKCE): Supabase redirects to Google, then back to /auth/callback,
    // where detectSessionInUrl exchanges the ?code and routes the user in.
    const redirectTo =
      typeof window !== "undefined" ? `${window.location.origin}/auth/callback` : undefined;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        // Always show the account chooser so a wrong-account login is recoverable.
        queryParams: { prompt: "select_account" },
      },
    });
    if (error) {
      setAuthError(friendlyAuthError(error));
      return false;
    }
    // On success the browser is already navigating to Google — nothing more to do.
    return true;
  };

  const signUp: AuthValue["signUp"] = async (email, password, name, referralCode) => {
    setAuthError(null);
    cancelPendingPurge();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name, referral_code: referralCode || null },
        // Return web sign-ups to the website after they confirm (falls back to
        // the project's Site URL if this origin isn't in the allow-list).
        emailRedirectTo:
          typeof window !== "undefined" ? `${window.location.origin}/login` : undefined,
      },
    });
    if (error) {
      const code = (error as { code?: string }).code;
      // Never confirm whether an email is already registered (account enumeration).
      // Mirror the neutral "check your email" outcome of a fresh sign-up instead of
      // leaking "account already exists". Fire a confirmation resend in case it's an
      // unconfirmed account (a no-op for a confirmed one).
      if (
        code === "user_already_exists" ||
        code === "email_exists" ||
        /already registered|already exists/i.test(error.message)
      ) {
        supabase.auth.resend({ type: "signup", email }).catch(() => {});
        setPendingEmail(email);
        track("sign_up");
        return true;
      }
      if (code === "over_email_send_rate_limit" || /rate limit/i.test(error.message)) {
        setAuthError("Too many sign-up emails were sent recently. Please wait a few minutes and try again.");
      } else {
        setAuthError(friendlyAuthError(error));
      }
      return false;
    }
    setOnbDone(false);
    if (data.session) {
      // Email confirmation is disabled on the project — the user is signed in
      // immediately. Set the session so the app gate routes them to onboarding.
      setSession(data.session);
    } else {
      // No session → confirmation required. If the email already exists, Supabase
      // obfuscates the response (data.user.identities comes back empty) and does
      // NOT send a fresh confirmation — the "I signed up before but never
      // confirmed, signed up again, and got no email" dead-end. Detect it and
      // explicitly resend so the user actually receives a link.
      const alreadyRegistered =
        !data.user?.identities || data.user.identities.length === 0;
      if (alreadyRegistered) {
        const { error: resendErr } = await supabase.auth.resend({
          type: "signup",
          email,
        });
        if (resendErr) {
          // Almost certainly an already-confirmed account → guide to sign in.
          setAuthError(
            'An account with this email already exists. Try signing in, or use "Forgot password?" to reset it.',
          );
          track("sign_up");
          return false;
        }
      }
      // Confirmation (re)sent — show the "check your email" screen.
      setPendingEmail(email);
    }
    track("sign_up");
    return true;
  };

  const resendConfirmation: AuthValue["resendConfirmation"] = async (email) => {
    setAuthError(null);
    const target = email || pendingEmail;
    if (!target) {
      setAuthError("No email to resend to.");
      return false;
    }
    const { error } = await supabase.auth.resend({ type: "signup", email: target });
    if (error) {
      setAuthError(friendlyAuthError(error));
      return false;
    }
    return true;
  };

  const clearPending = () => setPendingEmail(null);

  const resetPassword: AuthValue["resetPassword"] = async (email) => {
    setAuthError(null);
    const redirectTo =
      typeof window !== "undefined" ? `${window.location.origin}/reset-password` : undefined;
    // Use the implicit-flow recovery client so the emailed link isn't PKCE-bound to
    // this browser — the user can open it on their phone / another browser and the
    // hash token still establishes a session on /reset-password.
    const { error } = await getRecoveryClient().auth.resetPasswordForEmail(email, { redirectTo });
    if (error) {
      setAuthError(friendlyAuthError(error));
      return false;
    }
    return true;
  };

  const signOut = async () => {
    // Optimistic sign-out — the professional pattern: flip the UI to logged-out
    // IMMEDIATELY (the auth gate redirects to /login on the next render), then do
    // token revocation + storage cleanup in the background. The button must never
    // wait on a network call — that's what made sign-out feel dead for seconds.
    setSession(null);
    setOnbDone(true);
    setNeedsTerms(false);
    setPendingEmail(null);
    // Background: revokes this session's refresh token server-side and clears the
    // persisted session ('local' scope = this device only). Fire-and-forget.
    supabase.auth.signOut({ scope: "local" }).catch(() => {});
    // Clear cached profile/jobs/bookings so a shared computer never shows the
    // previous user's data.
    cacheClearAll();
    // Failsafe: if that SDK call wedges (held auth lock / dead network) before it
    // clears storage, purge the persisted session directly so a page reload can't
    // resurrect the login. Tracked + cancelled by any new auth attempt so it can
    // never delete a fresh code-verifier or a just-persisted new session.
    if (purgeTimer.current) clearTimeout(purgeTimer.current);
    purgeTimer.current = setTimeout(() => {
      purgeTimer.current = null;
      purgePersistedSession();
    }, 2000);
  };

  const clearError = () => setAuthError(null);

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        loading,
        onboardingResolved: onbResolved,
        authError,
        onboardingDone,
        pendingEmail,
        needsTermsAcceptance: !!session && onboardingDone && needsTerms,
        markTermsAccepted,
        signIn,
        signInWithGoogle,
        signUp,
        resetPassword,
        resendConfirmation,
        clearPending,
        signOut,
        clearError,
        markOnboardingDone,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = (): AuthValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
