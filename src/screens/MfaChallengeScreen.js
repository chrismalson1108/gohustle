// ─────────────────────────────────────────────────────────────────────────────
// The code prompt at sign-in.
//
// This screen is the entire reason two-factor is worth anything. A password sign-in
// on an account with a verified factor returns a REAL session at AAL1 — every other
// gate in RootNavigator would let it straight through to the app. Holding here is
// what makes the second factor a factor.
//
// It also carries the way back in. "I've lost my phone" is not an edge case; it is
// the single most common reason people are locked out of their own money, and a 2FA
// screen with no exit is how a support queue fills with cases nobody can verify.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useHaptic } from '../hooks/useHaptic';
import { supabase } from '../lib/supabase';
import {
  verifyChallenge, redeemRecoveryCode, formatRecoveryCode,
  factorLabel, preferredFactor,
} from '../lib/mfa';
import { colors, radii, shadows } from '../theme';

export default function MfaChallengeScreen() {
  const { clearMfaPending, signOut } = useAuth();
  const haptic = useHaptic();
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState('code');   // code | recovery
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Which entry in the authenticator we are about to challenge, so the copy can NAME it.
  // An admin holds two — the app's "GoHustlr" and the console's "GoHustlr Admin" — and
  // being told to open "GoHustlr" while the code is verified against the other one turns
  // a correct code into "that code was not accepted", with nothing on screen to explain
  // it. Purely presentational: submitCode does its own authoritative, fail-closed lookup.
  const [entry, setEntry] = useState(null);   // { label, count } | null

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      // A failed lookup means we simply cannot name the entry. It must not change what
      // the screen DOES — the gate holds either way — so fall back to the generic copy.
      if (!alive || error) return;
      const verified = (data?.totp ?? []).filter((f) => f.status === 'verified');
      const picked = preferredFactor(verified);
      if (picked) setEntry({ label: factorLabel(picked), count: verified.length });
    })();
    return () => { alive = false; };
  }, []);

  const submitCode = async () => {
    setBusy(true); setErr(null);
    try {
      // The `error` here is load-bearing and was being discarded. listFactors() is a
      // NETWORK call (auth-js delegates to getUser()), and on a failed fetch it
      // returns { data: null, error } rather than throwing. With the error dropped,
      // `factors` was null, `factor` undefined, and the next line took the
      // "this account has no factor after all" branch — clearing the gate and letting
      // the session into the app WITHOUT a code. Airplane mode was a 2FA bypass.
      //
      // A lookup that FAILED tells us nothing about whether a factor exists, so it
      // must leave the gate closed. Only a successful lookup returning none is
      // grounds for opening it.
      const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors();
      if (listErr) {
        setErr("Couldn't reach the server. Check your connection and try again.");
        return;
      }
      // preferredFactor, not "whichever GoTrue listed first": an account can hold two
      // verified TOTP factors (the app's "GoHustlr" and the console's "GoHustlr Admin"),
      // and this screen's copy tells the user which entry to open. Picking by list order
      // meant an admin who enrolled on the console first was challenged for one entry
      // while being told to use the other.
      const verified = (factors?.totp ?? []).filter((f) => f.status === 'verified');
      const factor = preferredFactor(verified);
      if (!factor) { clearMfaPending(); return; }
      setEntry({ label: factorLabel(factor), count: verified.length });
      await verifyChallenge(factor.id, code);
      haptic.success();
      clearMfaPending();
    } catch (e) {
      setErr(e.message); haptic.error(); setCode('');
    } finally { setBusy(false); }
  };

  const submitRecovery = async () => {
    setBusy(true); setErr(null);
    try {
      const ok = await redeemRecoveryCode(code);
      if (!ok) {
        // Deliberately one message for "wrong code", "already used" and "too many
        // tries" — distinguishing them would tell someone probing which codes exist.
        setErr('That code was not accepted. Each code works once.');
        haptic.error();
        return;
      }
      // redeemRecoveryCode has removed the factor AND refreshed this session, so the
      // stored user no longer lists one — clearing the gate here is the same answer the
      // next relaunch will reach on its own. It is only optimistic about the timing.
      // They are password-only now and the Security screen says so.
      haptic.success();
      clearMfaPending();
    } catch (e) {
      setErr(e.message); haptic.error();
    } finally { setBusy(false); }
  };

  const recovery = mode === 'recovery';

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top + 40 }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
        <View style={styles.badge}>
          <Ionicons name="shield-checkmark" size={28} color={colors.primary} />
        </View>

        <Text style={styles.title}>{recovery ? 'Use a recovery code' : 'Enter your code'}</Text>
        <Text style={styles.sub}>
          {recovery
            ? 'Enter one of the codes you saved when you turned on two-factor. Each works once, and using one turns two-factor off so you can set it up again on your new phone.'
            : `Open your authenticator app and enter the 6-digit code for “${entry?.label ?? 'GoHustlr'}”.`}
        </Text>

        {/* Only when there IS more than one entry. Saying it to everyone would send a
            normal user hunting through their authenticator for a second GoHustlr they
            do not have. */}
        {!recovery && entry?.count > 1 ? (
          <Text style={styles.entryHint}>
            You have more than one GoHustlr entry — this sign-in needs the one named
            “{entry.label}”.
          </Text>
        ) : null}

        <TextInput
          style={[styles.input, recovery && styles.inputWide]}
          value={recovery ? code : code}
          onChangeText={(t) => setCode(recovery ? formatRecoveryCode(t) : t.replace(/\D/g, '').slice(0, 6))}
          keyboardType={recovery ? 'default' : 'number-pad'}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder={recovery ? 'ABCD-EFGH' : '000000'}
          placeholderTextColor={colors.textMuted}
          maxLength={recovery ? 9 : 6}
          autoFocus
          textContentType={recovery ? 'none' : 'oneTimeCode'}
        />

        {err ? <Text style={styles.err}>{err}</Text> : null}

        <TouchableOpacity
          style={[styles.primaryBtn, (recovery ? code.length < 9 : code.length !== 6) && styles.btnDisabled]}
          onPress={recovery ? submitRecovery : submitCode}
          disabled={busy || (recovery ? code.length < 9 : code.length !== 6)}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Continue</Text>}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => { haptic.selection(); setMode(recovery ? 'code' : 'recovery'); setCode(''); setErr(null); }}
        >
          <Text style={styles.link}>
            {recovery ? 'I have my authenticator — enter a code' : "I've lost my phone"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => { haptic.selection(); signOut(); }}>
          <Text style={styles.signOut}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  inner: { paddingHorizontal: 28, alignItems: 'center' },
  badge: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center', marginBottom: 22,
  },
  title: { fontSize: 24, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },
  sub: {
    fontSize: 14, color: colors.textSecondary, textAlign: 'center',
    lineHeight: 21, marginTop: 10, marginBottom: 26,
  },
  input: {
    width: '100%', fontSize: 28, letterSpacing: 10, textAlign: 'center',
    color: colors.textPrimary, backgroundColor: colors.surface, borderRadius: radii.lg,
    paddingVertical: 16, ...shadows.sm,
  },
  inputWide: { fontSize: 22, letterSpacing: 4 },
  entryHint: {
    fontSize: 13, color: colors.textSecondary, textAlign: 'center',
    lineHeight: 20, marginTop: -16, marginBottom: 22, fontWeight: '600',
  },
  err: { fontSize: 13.5, color: colors.urgent, textAlign: 'center', marginTop: 14, lineHeight: 20 },
  primaryBtn: {
    width: '100%', backgroundColor: colors.primary, borderRadius: radii.pill,
    paddingVertical: 16, alignItems: 'center', marginTop: 20,
  },
  primaryText: { fontSize: 16, fontWeight: '800', color: '#fff' },
  btnDisabled: { opacity: 0.45 },
  link: { fontSize: 14, fontWeight: '700', color: colors.primary, marginTop: 24 },
  signOut: { fontSize: 13.5, color: colors.textSecondary, marginTop: 28, fontWeight: '600' },
});
