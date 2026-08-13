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
import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useHaptic } from '../hooks/useHaptic';
import { supabase } from '../lib/supabase';
import { verifyChallenge, redeemRecoveryCode, formatRecoveryCode } from '../lib/mfa';
import { colors, radii, shadows } from '../theme';

export default function MfaChallengeScreen() {
  const { clearMfaPending, signOut } = useAuth();
  const haptic = useHaptic();
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState('code');   // code | recovery
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submitCode = async () => {
    setBusy(true); setErr(null);
    try {
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const factor = (factors?.totp ?? []).find((f) => f.status === 'verified');
      if (!factor) { clearMfaPending(); return; }
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
      // The code removed the factor server-side, so this session is no longer waiting
      // on one. They are password-only now and the Security screen says so.
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
            : 'Open your authenticator app and enter the 6-digit code for GoHustlr.'}
        </Text>

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
