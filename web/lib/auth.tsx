"use client";

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase, purgePersistedSession, getRecoveryClient } from "./supabaseClient";
import { cacheClearAll } from "./cache";
import { track } from "./analytics";
import { checkNeedsAcceptance } from "./legal";

interface AuthValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
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
    // Resolve the initial session. supabase-js serializes auth calls behind a
    // navigator LockManager lock that is shared across every tab of the origin —
    // if another tab is holding it (a backgrounded/stuck tab), getSession() can
    // hang indefinitely. A confirmation/recovery `?code=` exchange can also fail.
    // Either way we must never leave `loading` true forever (that freezes the
    // whole app on the spinner), so we time the call out and always clear loading.
    (async () => {
      try {
        // Race the WHOLE init (session read + the onboarding/profile fetch) against
        // a timeout. loadOnboarding is a normal PostgREST call not covered by the
        // auth-lock timeout, so if IT stalls the gate would still hang on the spinner.
        await Promise.race([
          (async () => {
            const {
              data: { session },
            } = await supabase.auth.getSession();
            setSession(session);
            if (session?.user) await loadOnboarding(session.user.id);
          })(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("auth init timed out")), 8000),
          ),
        ]);
      } catch (err) {
        console.error("Auth init failed/timed out:", err);
      } finally {
        setLoading(false);
      }
    })();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setSession(session);
      if (session?.user) await loadOnboarding(session.user.id);
      else {
        setOnbDone(true);
        setNeedsTerms(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

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
      setAuthError(error.message);
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
      setAuthError(error.message);
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
      if (code === "over_email_send_rate_limit" || /rate limit/i.test(error.message)) {
        setAuthError("Too many sign-up emails were sent recently. Please wait a few minutes and try again.");
      } else {
        setAuthError(error.message);
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
      setAuthError(error.message);
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
      setAuthError(error.message);
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
