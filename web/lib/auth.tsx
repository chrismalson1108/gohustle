"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";
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

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session);
      if (session?.user) await loadOnboarding(session.user.id);
      setLoading(false);
    });

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
      .single();
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
    const { error } = await supabase.auth.signInWithPassword({ email, password });
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
    setPendingEmail(null);
    track("sign_in");
    return true;
  };

  const signUp: AuthValue["signUp"] = async (email, password, name, referralCode) => {
    setAuthError(null);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name, referral_code: referralCode || null } },
    });
    if (error) {
      setAuthError(error.message);
      return false;
    }
    setOnbDone(false);
    setPendingEmail(email);
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
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) {
      setAuthError(error.message);
      return false;
    }
    return true;
  };

  const signOut = async () => {
    await supabase.auth.signOut();
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
