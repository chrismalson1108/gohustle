import React, { createContext, useContext, useEffect, useState } from 'react';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { supabase } from '../lib/supabase';
import { unregisterPushToken } from '../lib/push';
import { track } from '../lib/analytics';
import { checkNeedsAcceptance } from '../lib/legal';

// Dismiss any lingering auth browser session on cold start (Android edge case).
WebBrowser.maybeCompleteAuthSession();

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

  const signInWithGoogle = async () => {
    setAuthError(null);
    try {
      // gohustlr://auth-callback in a dev/standalone build (the app scheme).
      const redirectTo = Linking.createURL('auth-callback');
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          skipBrowserRedirect: true, // we open the URL ourselves via WebBrowser
          queryParams: { prompt: 'select_account' },
        },
      });
      if (error || !data?.url) {
        setAuthError(error?.message || 'Could not start Google sign-in.');
        return false;
      }

      // Open Google's consent page in a secure in-app browser and wait for the
      // redirect back to our scheme.
      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      if (result.type !== 'success' || !result.url) {
        // User dismissed the browser or cancelled — not an error worth surfacing.
        return false;
      }

      // PKCE: the redirect carries a ?code we exchange for a real session.
      const { queryParams } = Linking.parse(result.url);
      if (queryParams?.error) {
        setAuthError(queryParams.error_description || 'Google sign-in was cancelled.');
        return false;
      }
      const code = queryParams?.code;
      if (!code) {
        setAuthError('Google sign-in did not return a valid response. Please try again.');
        return false;
      }
      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
      if (exchangeError) {
        setAuthError(exchangeError.message);
        return false;
      }
      // onAuthStateChange establishes the session + onboarding gate from here.
      setPendingEmail(null);
      track('sign_in');
      return true;
    } catch (err) {
      setAuthError(err?.message || 'Google sign-in failed. Please try again.');
      return false;
    }
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
    // Best-effort push-token cleanup, time-boxed so a stalled network call (e.g.
    // during a Supabase outage) can't block sign-out. Fire-and-forget.
    if (session?.user?.id) {
      Promise.race([
        unregisterPushToken(session.user.id),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]).catch(() => {});
    }
    // 'local' scope avoids the hangable 'global' server round-trip that can freeze
    // sign-out during an outage; it clears the stored session and fires
    // onAuthStateChange(null). Time it out and force-clear as a last resort.
    try {
      await Promise.race([
        supabase.auth.signOut({ scope: 'local' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('signOut timed out')), 5000)),
      ]);
    } catch {
      setSession(null);
    }
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
      signInWithGoogle,
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
