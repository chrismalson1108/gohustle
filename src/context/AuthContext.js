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
    // Resolve the initial session. getSession() OR the post-session profile read
    // can hang/reject (a corrupt or locked AsyncStorage session, a refresh-token
    // network stall). With no timeout `loading` would stay true forever, freezing
    // the app on the launch spinner with no recovery. Time-box the WHOLE init and
    // always clear loading so a bad state drops the user to AuthScreen instead.
    (async () => {
      try {
        await Promise.race([
          (async () => {
            const { data: { session } } = await supabase.auth.getSession();
            setSession(session);
            if (session?.user) await loadOnboarding(session.user.id);
          })(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('auth init timed out')), 8000)),
        ]);
      } catch (err) {
        console.error('Auth init failed/timed out:', err);
      } finally {
        setLoading(false);
      }
    })();

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
      .maybeSingle();
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
    // If the email already exists, Supabase obfuscates the response (empty
    // identities) and does NOT send a fresh confirmation — the "signed up before,
    // never confirmed, tried again, got no email" dead-end. Detect it and resend
    // explicitly so a link actually goes out.
    const alreadyRegistered = !data.user?.identities || data.user.identities.length === 0;
    if (alreadyRegistered) {
      const { error: resendErr } = await supabase.auth.resend({ type: 'signup', email });
      if (resendErr) {
        setAuthError('An account with this email already exists. Try signing in, or use "Forgot password".');
        return false;
      }
    }
    // Confirmation (re)sent — surface the "check your email" state.
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
    // Send users to the WEB reset page (which exchanges the recovery token and lets
    // them set a new password), not a custom gohustlr:// scheme — that scheme isn't
    // registered and the app has no deep-link handler / reset screen, so the link
    // was a dead end on mobile. The browser flow works on every platform.
    // NOTE: https://gohustlr.com/reset-password must be in the Supabase Auth
    // "Redirect URLs" allow-list (it already is for web password resets).
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://gohustlr.com/reset-password',
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
