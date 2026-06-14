import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { unregisterPushToken } from '../lib/push';
import { track } from '../lib/analytics';
import { checkNeedsAcceptance } from '../lib/legal';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession]         = useState(null);
  const [loading, setLoading]         = useState(true);
  const [authError, setAuthError]     = useState(null);
  const [onboardingDone, setOnbDone]  = useState(true);
  const [needsTerms, setNeedsTerms]   = useState(false); // re-accept current legal docs
  const [pendingEmail, setPendingEmail] = useState(null); // email awaiting confirmation

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session);
      if (session?.user) await loadOnboarding(session.user.id);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setSession(session);
      if (session?.user) await loadOnboarding(session.user.id);
      else { setOnbDone(true); setNeedsTerms(false); } // signed out → reset gates
    });

    return () => subscription.unsubscribe();
  }, []);

  // Derive onboarding + legal-acceptance state whenever a session is established.
  // Returning users have onboarding_done=true (skip onboarding); the legal gate
  // is driven by the DB (current legal_documents vs the user's legal_acceptances).
  const loadOnboarding = async (userId) => {
    const { data } = await supabase
      .from('profiles')
      .select('onboarding_done')
      .eq('id', userId)
      .single();
    const done = data?.onboarding_done ?? false;
    setOnbDone(done);
    // Onboarding records acceptance itself, so only gate already-onboarded users.
    setNeedsTerms(done ? await checkNeedsAcceptance(userId) : false);
  };

  const markOnboardingDone = () => {
    setOnbDone(true);
    setNeedsTerms(false); // onboarding records current acceptances
  };

  const markTermsAccepted = () => setNeedsTerms(false);

  const signIn = async (email, password) => {
    setAuthError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      // Email confirmation required but not yet done
      if (error.code === 'email_not_confirmed' || /email not confirmed/i.test(error.message)) {
        setPendingEmail(email);
        setAuthError('Please confirm your email first — check your inbox for the link.');
        return false;
      }
      setAuthError(error.message);
      return false;
    }
    setPendingEmail(null);
    track('sign_in');
    return true;
  };

  const signUp = async (email, password, name, referralCode) => {
    setAuthError(null);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name, referral_code: referralCode || null } },
    });
    if (error) { setAuthError(error.message); return false; }
    setOnbDone(false);
    // With email confirmation on, signUp returns no session — the user must
    // confirm via the emailed link, then sign in. Surface that state.
    setPendingEmail(email);
    track('sign_up');
    return true;
  };

  const resendConfirmation = async (email) => {
    setAuthError(null);
    const target = email || pendingEmail;
    if (!target) { setAuthError('No email to resend to.'); return false; }
    const { error } = await supabase.auth.resend({ type: 'signup', email: target });
    if (error) { setAuthError(error.message); return false; }
    return true;
  };

  const clearPending = () => setPendingEmail(null);

  const resetPassword = async (email) => {
    setAuthError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'gohustlr://reset-password',
    });
    if (error) { setAuthError(error.message); return false; }
    return true;
  };

  const signOut = async () => {
    if (session?.user?.id) await unregisterPushToken(session.user.id);
    await supabase.auth.signOut();
  };

  const clearError = () => setAuthError(null);

  return (
    <AuthContext.Provider value={{
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
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
