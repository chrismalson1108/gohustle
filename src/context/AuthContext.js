import React, { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession]         = useState(null);
  const [loading, setLoading]         = useState(true);
  const [authError, setAuthError]     = useState(null);
  const [onboardingDone, setOnbDone]  = useState(true);
  const [justSignedUp, setJustSignedUp] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Only check onboarding when a fresh signup just occurred
  useEffect(() => {
    if (justSignedUp && session?.user) {
      checkOnboarding(session.user.id);
    }
  }, [justSignedUp, session?.user?.id]);

  const checkOnboarding = async (userId) => {
    const { data } = await supabase
      .from('profiles')
      .select('onboarding_done')
      .eq('id', userId)
      .single();
    setOnbDone(data?.onboarding_done ?? false);
  };

  const markOnboardingDone = () => {
    setOnbDone(true);
    setJustSignedUp(false);
  };

  const signIn = async (email, password) => {
    setAuthError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setAuthError(error.message); return false; }
    return true;
  };

  const signUp = async (email, password, name) => {
    setAuthError(null);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name } },
    });
    if (error) { setAuthError(error.message); return false; }
    setJustSignedUp(true);
    setOnbDone(false);
    return true;
  };

  const resetPassword = async (email) => {
    setAuthError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'gohustlr://reset-password',
    });
    if (error) { setAuthError(error.message); return false; }
    return true;
  };

  const signOut = async () => {
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
      signIn,
      signUp,
      resetPassword,
      signOut,
      clearError,
      markOnboardingDone,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
