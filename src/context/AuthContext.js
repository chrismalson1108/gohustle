import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { supabase, recoveryAuthClient, purgePersistedSession } from '../lib/supabase';
import { cacheClear } from '../lib/cache';
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
  const purgeTimer = useRef(null); // pending post-sign-out storage purge

  // Any new auth attempt must cancel a pending sign-out purge, or the timer
  // would delete the new flow's PKCE code-verifier / freshly stored session.
  const cancelPendingPurge = () => {
    if (purgeTimer.current) { clearTimeout(purgeTimer.current); purgeTimer.current = null; }
  };

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
    cancelPendingPurge();
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
    cancelPendingPurge();
    try {
      // gohustlr://auth-callback in a dev/standalone build (the app scheme).
      const redirectTo = Linking.createURL('auth-callback');
      // In Expo Go the redirect is exp://… which isn't (and shouldn't be) in the
      // Supabase allow-list — the flow would silently dead-end after Google.
      // Surface a clear message instead.
      if (!redirectTo.startsWith('gohustlr://')) {
        setAuthError('Google sign-in needs the GoHustlr app build — it isn\'t available in Expo Go. Use email sign-in here.');
        return false;
      }
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
    cancelPendingPurge();
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
    // Uses the IMPLICIT-flow recovery client: the main client is PKCE (for Google
    // OAuth), and a PKCE recovery link can only be exchanged by the device that
    // requested it — the web reset page would dead-end at "Auth session missing".
    const { error } = await recoveryAuthClient.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://gohustlr.com/reset-password',
    });
    if (error) { setAuthError(error.message); return false; }
    return true;
  };

  const signOut = async () => {
    const userId = session?.user?.id;
    // Optimistic sign-out — the professional pattern: flip the UI to logged-out
    // IMMEDIATELY (RootNavigator drops to AuthScreen on the next render), then do
    // all cleanup in the background. Sign-out must never wait on a network call.
    setSession(null);
    setOnbDone(true);
    setNeedsTerms(false);
    setPendingEmail(null);
    // Background: push-token cleanup + refresh-token revocation ('local' scope =
    // this device only). Fire-and-forget — failures are irrelevant to the user.
    if (userId) unregisterPushToken(userId).catch(() => {});
    supabase.auth.signOut({ scope: 'local' }).catch(() => {});
    // Drop cached profile/jobs/bookings so a shared device never shows the
    // previous user's data.
    cacheClear();
    // Failsafe: if the SDK call wedges before it clears storage, purge the
    // persisted session directly so an app relaunch can't resurrect the login.
    // Tracked + cancelled by any new auth attempt: an unconditional timer would
    // delete a freshly written PKCE code-verifier (breaking a quick account
    // switch via Google) or a just-persisted new session.
    if (purgeTimer.current) clearTimeout(purgeTimer.current);
    purgeTimer.current = setTimeout(() => { purgeTimer.current = null; purgePersistedSession(); }, 2000);
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
