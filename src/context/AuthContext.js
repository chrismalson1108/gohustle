import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { supabase, recoveryAuthClient, purgePersistedSession } from '../lib/supabase';
import { cacheClear } from '../lib/cache';
import { unregisterPushToken } from '../lib/push';
import { track } from '../lib/analytics';
import { checkNeedsAcceptance } from '../lib/legal';
import { betaSignupMessage } from '../lib/authErrors';

// Dismiss any lingering auth browser session on cold start (Android edge case).
WebBrowser.maybeCompleteAuthSession();

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession]         = useState(null);
  const [loading, setLoading]         = useState(true);
  const [authError, setAuthError]     = useState(null);
  const [onboardingDone, setOnbDone]  = useState(true);
  // False until onboarding/terms state has loaded for the current session — the
  // RootNavigator gate must wait on this before trusting the optimistic
  // onboardingDone=true default, or a fresh sign-in flashes MainApp before routing
  // to onboarding/consent. Mirrors web onboardingResolved.
  const [onbResolved, setOnbResolved] = useState(false);
  const [needsTerms, setNeedsTerms]   = useState(false); // re-accept current legal docs
  const [pendingEmail, setPendingEmail] = useState(null); // email awaiting confirmation
  const purgeTimer = useRef(null); // pending post-sign-out storage purge
  const lastUserId = useRef(null); // previous session's user, to clean up on expiry

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
        const { data: { session } } = await Promise.race([
          supabase.auth.getSession(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('auth init timed out')), 8000)),
        ]);
        lastUserId.current = session?.user?.id ?? null;
        setSession(session);
        // No user → release the gate now. With a user, the keyed onboarding effect
        // below releases loading once it resolves, so a not-onboarded user never
        // flashes MainApp before being routed to onboarding.
        if (!session?.user) { setOnbResolved(true); setLoading(false); }
      } catch (err) {
        console.error('Auth init failed/timed out:', err);
        setOnbResolved(true);
        setLoading(false);
      }
    })();

    // CRITICAL: this callback MUST stay synchronous — never await a Supabase data
    // call here. supabase-js awaits every subscriber inside its event emission, so
    // an awaited profile read couples auth events to network latency (and, if a
    // lock is ever configured, can deadlock the client — the exact web bug). The
    // onboarding read runs in the keyed effect below, outside the callback.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const prevUserId = lastUserId.current;
      lastUserId.current = session?.user?.id ?? null;
      setSession(session);
      if (!session?.user) {
        setOnbDone(true); setNeedsTerms(false); setOnbResolved(true); setLoading(false); // signed out → reset gates
        // A NATURAL session expiry (refresh-token failure) fires here WITHOUT going
        // through signOut(), which is the only place that cleared cache + push token.
        // Without this, the next account on the device could briefly see the previous
        // user's cached bookings and the device kept receiving their notifications.
        // Only when we actually HAD a user (not a cold-start null). Idempotent with signOut().
        if (prevUserId) {
          cacheClear();
          unregisterPushToken(prevUserId).catch(() => {});
        }
      }
      // With a user, the keyed onboarding effect below owns loading + onboarding.
    });

    return () => subscription.unsubscribe();
  }, []);

  // Load onboarding + legal-acceptance state whenever the signed-in user changes —
  // OUTSIDE the auth callback so a slow/stalled profile read never blocks the auth
  // event chain. Time-boxed so loading always releases. Mirrors web/lib/auth.tsx.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    let cancelled = false;
    (async () => {
      setOnbResolved(false); // new user → close the gate until onboarding resolves
      try {
        await Promise.race([
          loadOnboarding(uid),
          new Promise((_, reject) => setTimeout(() => reject(new Error('onboarding load timed out')), 8000)),
        ]);
      } catch (err) {
        console.error('Onboarding load failed/timed out:', err);
      } finally {
        if (!cancelled) { setOnbResolved(true); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [session?.user?.id]);

  // Derive onboarding + legal-acceptance state whenever a session is established.
  // Returning users have onboarding_done=true (skip onboarding); the legal gate
  // is driven by the DB (current legal_documents vs the user's legal_acceptances).
  const loadOnboarding = async (userId) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('onboarding_done')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      // Read failed — do NOT demote an established user into the wizard. Leave
      // onboardingDone at its prior/optimistic value; a relaunch re-evaluates.
      console.warn('loadOnboarding read failed:', error.message);
      return;
    }
    const done = data?.onboarding_done ?? false; // null data (no error) = new user
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

  const signInWithApple = async () => {
    setAuthError(null);
    cancelPendingPurge();
    try {
      // Apple embeds sha256(rawNonce) in the identity token; Supabase re-hashes the
      // raw nonce we pass and compares — protects against token replay.
      const rawNonce = Array.from(Crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: hashedNonce,
      });
      if (!credential.identityToken) {
        setAuthError('Apple sign-in didn\'t return a token. Please try again.');
        return false;
      }
      const { data, error } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken,
        nonce: rawNonce,
      });
      if (error) { setAuthError(error.message); return false; }
      // Apple returns the user's name ONLY on the very first authorization. Persist
      // it so the profile isn't stuck on the email-derived default. (Subsequent
      // sign-ins return null fullName, so a returning user's name is never clobbered.)
      const fn = credential.fullName;
      const name = [fn?.givenName, fn?.familyName].filter(Boolean).join(' ').trim();
      if (name && data?.user?.id) {
        await supabase.from('profiles').update({ name, avatar_initial: name[0].toUpperCase() }).eq('id', data.user.id).then(() => {}, () => {});
      }
      setPendingEmail(null);
      track('sign_in');
      return true;
    } catch (e) {
      if (e?.code === 'ERR_REQUEST_CANCELED') return false; // user tapped Cancel
      setAuthError(e?.message || 'Apple sign-in failed. Please try again.');
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
    // A non-allowlisted email is rejected server-side by the closed-beta gate
    // (handle_new_user trigger); GoTrue surfaces it as a generic DB error, so map it
    // to beta-appropriate copy. See src/lib/authErrors.js.
    if (error) { setAuthError(betaSignupMessage(error)); return false; }
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
      onboardingResolved: onbResolved,
      authError,
      onboardingDone,
      pendingEmail,
      needsTermsAcceptance: !!session && onboardingDone && needsTerms,
      markTermsAccepted,
      signIn,
      signInWithGoogle,
      signInWithApple,
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
