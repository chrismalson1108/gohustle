// ─────────────────────────────────────────────────────────────────────────────
// Two-factor authentication.
//
// The enrollment order here is the REVERSE of every web guide, on purpose. The web
// shows a QR because it assumes two screens — a laptop displaying it and a phone
// scanning it. On a phone there is one screen and it cannot photograph itself, so a
// QR is the one thing that definitely does not work. The otpauth:// deep link does:
// the OS offers whichever authenticators are installed, and one tap moves the secret
// across with nothing typed.
//
// No new native dependencies, deliberately — a QR renderer or a clipboard module
// would force a store build, and this needs to reach people over the air. The secret
// is shown in a selectable field (long-press → Copy) and Share covers the rest.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, Linking, Share, Alert, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import ScreenHeader from '../components/ScreenHeader';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import {
  fetchMfaStatus, startEnrollment, confirmEnrollment, disableMfa,
  generateRecoveryCodes, confirmRecoveryCodes,
} from '../lib/mfa';
import { colors, radii, shadows } from '../theme';

export default function SecurityScreen() {
  const { showToast } = useUser();
  const haptic = useHaptic();

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('idle');      // idle | setup | verify | codes | disable
  const [enroll, setEnroll] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try { setStatus(await fetchMfaStatus()); } catch (_) { setStatus(null); }
    finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const begin = async () => {
    haptic.medium(); setErr(null); setBusy(true);
    try {
      setEnroll(await startEnrollment());
      setStep('setup');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  // THE PRIMARY ROUTE. Hands otpauth:// to the OS, which offers every installed
  // authenticator. If nothing handles it, say so plainly and point at the key rather
  // than leaving a dead button.
  const openAuthenticator = async () => {
    if (!enroll?.uri) return;
    haptic.medium();
    try {
      const ok = await Linking.canOpenURL(enroll.uri);
      if (!ok) {
        return showToast({
          icon: '🔐',
          title: 'No authenticator app found',
          message: 'Install one, or use the setup key below.',
        });
      }
      await Linking.openURL(enroll.uri);
    } catch (_) {
      showToast({ icon: '🔐', title: 'Could not open it', message: 'Use the setup key below instead.' });
    }
  };

  // Generate, show, and only THEN retire the previous set. The old codes stay valid
  // until confirmRecoveryCodes lands, so a dropped response leaves the user with codes
  // that work rather than none at all.
  const showFreshCodes = async () => {
    const fresh = await generateRecoveryCodes();
    setCodes(fresh);
    setStep('codes');
    await confirmRecoveryCodes();
    return fresh;
  };

  const verify = async () => {
    haptic.medium(); setErr(null); setBusy(true);
    // Tracked separately because the two halves fail differently and the SECOND one
    // failing does not undo the first.
    let factorOn = false;
    try {
      await confirmEnrollment(enroll.factorId, code);
      factorOn = true;
      // Recovery codes are generated IMMEDIATELY, not offered later. 2FA without a way
      // back in turns a lost phone into a lost account, and "I'll do it later" is how
      // that happens.
      await showFreshCodes();
      setCode('');
      haptic.success();
    } catch (e) {
      // If the factor verified and only the CODES failed, two-factor is genuinely ON.
      // Reporting the generic error here told the user enrolment had failed while the
      // card still read "Off" — so they walked away believing they had no 2FA and no
      // recovery codes, when in fact they had 2FA and no recovery codes. That is the
      // exact state that turns a lost phone into a lost account.
      setErr(factorOn
        ? 'Two-factor is now ON, but we could not create your recovery codes. '
          + 'Tap “Regenerate recovery codes” before you lose access to this device.'
        : e.message);
      haptic.error();
    } finally {
      // ALWAYS reload — in the finally, not on the success path. Once the factor is
      // verified the card must never still claim "Off", whatever happened afterwards.
      await load();
      setBusy(false);
    }
  };

  const regenerate = async () => {
    haptic.medium(); setErr(null); setBusy(true);
    try {
      await showFreshCodes();
    } catch (e) { setErr(e.message); } finally { await load(); setBusy(false); }
  };

  const turnOff = async () => {
    haptic.medium(); setErr(null); setBusy(true);
    try {
      await disableMfa(status.factors[0].id, code);
      setStep('idle'); setCode('');
      showToast({ icon: '🔓', title: 'Two-factor is off', message: 'Your account is password-only again.' });
      await load();
    } catch (e) { setErr(e.message); haptic.error(); } finally { setBusy(false); }
  };

  const shareCodes = async () => {
    haptic.light();
    try {
      await Share.share({
        title: 'GoHustlr recovery codes',
        message:
          'GoHustlr recovery codes — each one works once.\n\n' +
          `${(codes ?? []).join('\n')}\n\n` +
          'Keep these somewhere safe and separate from your phone. ' +
          'If you lose your authenticator app, one of these gets you back in.',
      });
    } catch (_) {}
  };

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>;
  }

  const on = status?.enabled;

  // automaticallyAdjustKeyboardInsets: the "enter the 6-digit code" and "turn off
  // two-factor" cards render BELOW the status card, so on a short screen the keyboard
  // covered the field being typed into. Same pair the rest of the app uses — insets on
  // the scrolling body, KeyboardAvoidingView on bottom sheets.
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingBottom: 48 }}
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
      <ScreenHeader topInset={false}>
        <Text style={styles.sub}>Extra protection for your account and your money.</Text>
      </ScreenHeader>

      <View style={styles.body}>
        {/* ── Status ─────────────────────────────────────────────────────── */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <View style={[styles.badge, { backgroundColor: on ? colors.successLight : colors.border }]}>
              <Ionicons
                name={on ? 'shield-checkmark' : 'shield-outline'}
                size={20}
                color={on ? colors.success : colors.textSecondary}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Two-factor authentication</Text>
              <Text style={styles.cardSub}>{on ? 'On' : 'Off'}</Text>
            </View>
          </View>

          <Text style={styles.cardBody}>
            {on
              ? 'Signing in needs a code from your authenticator app as well as your password.'
              : 'Your account is protected by your password alone. Because your account is '
                + 'connected to your payout details, anyone who gets that password can change '
                + 'where your money goes.'}
          </Text>

          {step === 'idle' && !on && (
            <TouchableOpacity style={styles.primaryBtn} onPress={begin} disabled={busy}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Turn on two-factor</Text>}
            </TouchableOpacity>
          )}

          {step === 'idle' && on && (
            <>
              <View style={styles.recoveryRow}>
                <Ionicons name="key-outline" size={16} color={colors.textSecondary} />
                <Text style={styles.recoveryText}>
                  {status.recovery.remaining} recovery code{status.recovery.remaining === 1 ? '' : 's'} left
                </Text>
              </View>
              {status.recovery.remaining === 0 && (
                <Text style={styles.warn}>
                  You have no recovery codes. If you lose your phone you will not be able to
                  get back in — make a new set now.
                </Text>
              )}
              <TouchableOpacity style={styles.outlineBtn} onPress={regenerate} disabled={busy}>
                <Text style={styles.outlineText}>
                  {status.recovery.remaining > 0 ? 'New recovery codes' : 'Create recovery codes'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => { haptic.selection(); setStep('disable'); }}>
                <Text style={styles.dangerLink}>Turn off two-factor</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* ── Setup ──────────────────────────────────────────────────────── */}
        {step === 'setup' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Add GoHustlr to your authenticator</Text>

            <TouchableOpacity style={styles.primaryBtn} onPress={openAuthenticator}>
              <Ionicons name="open-outline" size={17} color="#fff" />
              <Text style={styles.primaryText}>Open my authenticator app</Text>
            </TouchableOpacity>
            <Text style={styles.hint}>
              Works with Google Authenticator, 1Password, Authy, Duo and others. Your
              phone will ask which one to use.
            </Text>

            <Text style={styles.orLabel}>Or add it by hand</Text>
            <Text style={styles.hint}>
              Long-press the key to copy it, then paste it into your authenticator as a
              new account. {Platform.OS === 'ios' ? '' : ''}
            </Text>
            {/* Selectable rather than a Copy button: a clipboard module is native code
                and would cost a store build. Long-press → Copy is the OS's own path. */}
            <TextInput
              style={styles.secret}
              value={enroll?.secret ?? ''}
              editable={false}
              selectTextOnFocus
              multiline
            />
            <Text style={styles.hintSmall}>
              It will appear as “GoHustlr”. Authenticator apps show their own icons from
              a built-in list, so it may have a plain letter icon rather than our logo.
            </Text>

            <TouchableOpacity style={styles.outlineBtn} onPress={() => { haptic.selection(); setStep('verify'); }}>
              <Text style={styles.outlineText}>I've added it — next</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setStep('idle'); setEnroll(null); }}>
              <Text style={styles.cancelLink}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Verify ─────────────────────────────────────────────────────── */}
        {step === 'verify' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Enter the 6-digit code</Text>
            <Text style={styles.cardBody}>From your authenticator app. It changes every 30 seconds.</Text>
            <TextInput
              style={styles.codeInput}
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              placeholder="000000"
              placeholderTextColor={colors.textMuted}
              maxLength={6}
              autoFocus
              textContentType="oneTimeCode"
            />
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <TouchableOpacity
              style={[styles.primaryBtn, code.length !== 6 && styles.btnDisabled]}
              onPress={verify}
              disabled={busy || code.length !== 6}
            >
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Turn on two-factor</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setStep('setup'); setErr(null); }}>
              <Text style={styles.cancelLink}>Back</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Recovery codes ─────────────────────────────────────────────── */}
        {step === 'codes' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Save your recovery codes</Text>
            <Text style={styles.cardBody}>
              Each code works once. If you lose your phone, one of these is the only way
              back into your account — including your earnings and payout details.
              We cannot show them again.
            </Text>
            <View style={styles.codeGrid}>
              {(codes ?? []).map((c) => (
                <Text key={c} style={styles.codeChip} selectable>{c}</Text>
              ))}
            </View>
            <TouchableOpacity style={styles.primaryBtn} onPress={shareCodes}>
              <Ionicons name="share-outline" size={17} color="#fff" />
              <Text style={styles.primaryText}>Save them somewhere safe</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.outlineBtn}
              onPress={() => {
                Alert.alert(
                  'Saved them?',
                  'These cannot be shown again. Without them, a lost phone means a lost account.',
                  [
                    { text: 'Not yet', style: 'cancel' },
                    { text: "I've saved them", onPress: () => { setStep('idle'); setCodes(null); } },
                  ],
                );
              }}
            >
              <Text style={styles.outlineText}>Done</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Disable ────────────────────────────────────────────────────── */}
        {step === 'disable' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Turn off two-factor</Text>
            <Text style={styles.cardBody}>
              Enter a current code to confirm it is you. Afterwards your account is
              protected by your password alone.
            </Text>
            <TextInput
              style={styles.codeInput}
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
              placeholder="000000"
              placeholderTextColor={colors.textMuted}
              maxLength={6}
              autoFocus
              textContentType="oneTimeCode"
            />
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <TouchableOpacity
              style={[styles.dangerBtn, code.length !== 6 && styles.btnDisabled]}
              onPress={turnOff}
              disabled={busy || code.length !== 6}
            >
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Turn it off</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setStep('idle'); setCode(''); setErr(null); }}>
              <Text style={styles.cancelLink}>Keep it on</Text>
            </TouchableOpacity>
          </View>
        )}

        {err && step === 'idle' ? <Text style={styles.err}>{err}</Text> : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  h1: { fontSize: 26, fontWeight: '800', color: colors.textPrimary },
  sub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  body: { padding: 16, gap: 14 },

  card: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, ...shadows.card },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  badge: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '800', color: colors.textPrimary },
  cardSub: { fontSize: 13, color: colors.textSecondary, marginTop: 1 },
  cardBody: { fontSize: 13.5, color: colors.textSecondary, lineHeight: 20, marginBottom: 14 },

  primaryBtn: {
    flexDirection: 'row', gap: 8, backgroundColor: colors.primary, borderRadius: radii.pill,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginTop: 4,
  },
  primaryText: { fontSize: 15, fontWeight: '800', color: '#fff' },
  dangerBtn: {
    backgroundColor: colors.urgent, borderRadius: radii.pill, paddingVertical: 14,
    alignItems: 'center', justifyContent: 'center', marginTop: 4,
  },
  outlineBtn: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill,
    paddingVertical: 13, alignItems: 'center', marginTop: 10,
  },
  outlineText: { fontSize: 14.5, fontWeight: '700', color: colors.textPrimary },
  btnDisabled: { opacity: 0.45 },
  dangerLink: { fontSize: 14, fontWeight: '700', color: colors.urgent, textAlign: 'center', marginTop: 14 },
  cancelLink: { fontSize: 14, fontWeight: '600', color: colors.textSecondary, textAlign: 'center', marginTop: 14 },

  hint: { fontSize: 12.5, color: colors.textSecondary, lineHeight: 18, marginTop: 8 },
  hintSmall: { fontSize: 11.5, color: colors.textMuted, lineHeight: 17, marginTop: 8 },
  orLabel: {
    fontSize: 11, fontWeight: '800', color: colors.textSecondary, textTransform: 'uppercase',
    letterSpacing: 0.5, marginTop: 20,
  },
  secret: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 15, color: colors.textPrimary, backgroundColor: colors.background,
    borderRadius: radii.md, padding: 12, marginTop: 8, letterSpacing: 1,
  },
  codeInput: {
    fontSize: 26, letterSpacing: 8, textAlign: 'center', color: colors.textPrimary,
    backgroundColor: colors.background, borderRadius: radii.md, paddingVertical: 14, marginBottom: 12,
  },
  err: { fontSize: 13, color: colors.urgent, lineHeight: 19, marginBottom: 10 },
  warn: { fontSize: 12.5, color: colors.warningDeep, lineHeight: 18, marginTop: 8 },

  recoveryRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 2 },
  recoveryText: { fontSize: 13.5, color: colors.textSecondary, fontWeight: '600' },

  codeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  codeChip: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 14, color: colors.textPrimary, backgroundColor: colors.background,
    paddingVertical: 9, paddingHorizontal: 12, borderRadius: radii.sm, letterSpacing: 1,
  },
});
