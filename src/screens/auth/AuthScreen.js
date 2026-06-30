import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Image,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, Keyboard, Modal,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Logo from '../../components/Logo';
import { useAuth } from '../../context/AuthContext';
import { fetchCurrentDocs } from '../../lib/legal';
import { colors, gradients, shadows } from '../../theme';

// tab: 'signin' | 'signup' | 'forgot'
export default function AuthScreen() {
  const { signIn, signUp, resetPassword, resendConfirmation, clearPending, pendingEmail, authError, clearError } = useAuth();
  const insets = useSafeAreaInsets();
  const [tab, setTab]           = useState('signin');
  const [name, setName]         = useState('');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [referral, setReferral] = useState('');
  const [loading, setLoading]   = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [localError, setLocalError] = useState('');
  const [resendMsg, setResendMsg]   = useState('');
  const [resending, setResending]   = useState(false);
  const [accepted, setAccepted]     = useState(false);
  const [legalDoc, setLegalDoc]     = useState(null); // 'terms'|'privacy'|'contractor'
  const [legalDocs, setLegalDocs]   = useState({});   // current docs from DB

  useEffect(() => { fetchCurrentDocs().then(setLegalDocs).catch(() => {}); }, []);

  const showVerify = !!pendingEmail;

  const switchTab = (t) => {
    setTab(t);
    clearError();
    setSuccessMsg('');
    setLocalError('');
    setName('');
    setEmail('');
    setPassword('');
    setConfirmPw('');
    setReferral('');
    setAccepted(false);
  };

  const handleSubmit = async () => {
    Keyboard.dismiss();
    setLocalError('');
    if (tab === 'forgot') {
      if (!email) { setLocalError('Enter your email address'); return; }
      setLoading(true);
      const ok = await resetPassword(email.trim());
      setLoading(false);
      if (ok) {
        setSuccessMsg('Reset email sent! Check your inbox and follow the link.');
        switchTab('signin');
      }
      return;
    }

    if (!email || !password || (tab === 'signup' && (!name || !confirmPw))) return;

    if (tab === 'signup') {
      if (password.length < 8) { setLocalError('Password must be at least 8 characters'); return; }
      if (password !== confirmPw) { setLocalError('Passwords do not match'); return; }
      if (!accepted) { setLocalError('Please confirm you are 18 or older and accept the Terms, Privacy Policy, and Contractor Agreement'); return; }
    }

    setLoading(true);
    setSuccessMsg('');
    if (tab === 'signin') {
      await signIn(email.trim(), password);
    } else {
      // On success, AuthContext sets pendingEmail → the verify panel takes over.
      await signUp(email.trim(), password, name.trim(), referral.trim());
    }
    setLoading(false);
  };

  const handleResend = async () => {
    setResendMsg('');
    setResending(true);
    const ok = await resendConfirmation(pendingEmail);
    setResending(false);
    if (ok) setResendMsg('Confirmation email sent! Check your inbox (and spam).');
  };

  const isReady = tab === 'forgot'
    ? !!email
    : email && password && (tab === 'signin' || (name && confirmPw && accepted));

  const errorMsg = localError || authError;

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">

        <LinearGradient colors={gradients.primary} style={[styles.hero, { paddingTop: insets.top + 44 }]}>
          <Logo light height={72} style={styles.heroLogo} />
          <Text style={styles.heroSub}>Get paid to hustle. Post gigs. Earn money.</Text>
        </LinearGradient>

        <View style={styles.card}>

          {showVerify ? (
            <View style={styles.verifyWrap}>
              <View style={styles.verifyIcon}>
                <Ionicons name="mail-unread" size={38} color={colors.primary} />
              </View>
              <Text style={styles.verifyTitle}>Verify your email</Text>
              <Text style={styles.verifySub}>
                We sent a confirmation link to{'\n'}
                <Text style={styles.verifyEmail}>{pendingEmail}</Text>.{'\n'}
                Tap it, then come back and sign in.
              </Text>

              {!!resendMsg && (
                <View style={styles.successBox}><Text style={styles.successText}>✓ {resendMsg}</Text></View>
              )}
              {!!authError && (
                <View style={styles.errorBox}><Text style={styles.errorText}>⚠ {authError}</Text></View>
              )}

              <TouchableOpacity onPress={() => { clearPending(); setResendMsg(''); switchTab('signin'); }} activeOpacity={0.85}>
                <LinearGradient colors={gradients.primary} style={styles.submitBtn}>
                  <Text style={styles.submitText}>I've confirmed — Sign in</Text>
                </LinearGradient>
              </TouchableOpacity>

              <TouchableOpacity onPress={handleResend} disabled={resending} style={styles.forgotLink}>
                {resending
                  ? <ActivityIndicator color={colors.primary} />
                  : <Text style={styles.forgotLinkText}>Resend confirmation email</Text>}
              </TouchableOpacity>

              <TouchableOpacity onPress={() => { clearPending(); setResendMsg(''); switchTab('signup'); }} style={styles.forgotLink}>
                <Text style={styles.switchHint}>Use a different email</Text>
              </TouchableOpacity>
            </View>
          ) : (<>

          {tab !== 'forgot' && (
            <View style={styles.tabs}>
              {['signin', 'signup'].map(t => (
                <TouchableOpacity
                  key={t}
                  style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
                  onPress={() => switchTab(t)}
                >
                  <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                    {t === 'signin' ? 'Sign In' : 'Create Account'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {tab === 'forgot' && (
            <View style={styles.forgotHeader}>
              <Text style={styles.forgotTitle}>Reset Password</Text>
              <Text style={styles.forgotSub}>Enter your email and we'll send a reset link.</Text>
            </View>
          )}

          {!!successMsg && (
            <View style={styles.successBox}>
              <Text style={styles.successText}>✓ {successMsg}</Text>
            </View>
          )}

          {!!errorMsg && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>⚠ {errorMsg}</Text>
            </View>
          )}

          {tab === 'signup' && (
            <View style={styles.field}>
              <Text style={styles.label}>Your Name</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. Alex Johnson"
                placeholderTextColor={colors.textMuted}
                value={name}
                onChangeText={setName}
                autoCapitalize="words"
                returnKeyType="next"
              />
            </View>
          )}

          <View style={styles.field}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              placeholder="you@example.com"
              placeholderTextColor={colors.textMuted}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType={tab === 'forgot' ? 'send' : 'next'}
              onSubmitEditing={tab === 'forgot' ? handleSubmit : undefined}
            />
          </View>

          {tab !== 'forgot' && (
            <View style={styles.field}>
              <Text style={styles.label}>Password</Text>
              <TextInput
                style={styles.input}
                placeholder={tab === 'signup' ? 'At least 6 characters' : '••••••••'}
                placeholderTextColor={colors.textMuted}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                returnKeyType={tab === 'signin' ? 'go' : 'next'}
                onSubmitEditing={tab === 'signin' ? handleSubmit : undefined}
              />
            </View>
          )}

          {tab === 'signup' && (
            <View style={styles.field}>
              <Text style={styles.label}>Confirm Password</Text>
              <TextInput
                style={styles.input}
                placeholder="Re-enter password"
                placeholderTextColor={colors.textMuted}
                value={confirmPw}
                onChangeText={setConfirmPw}
                secureTextEntry
                returnKeyType="next"
              />
            </View>
          )}

          {tab === 'signup' && (
            <View style={styles.field}>
              <Text style={styles.label}>Referral code (optional)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. A1B2C3"
                placeholderTextColor={colors.textMuted}
                value={referral}
                onChangeText={t => setReferral(t.toUpperCase())}
                autoCapitalize="characters"
                autoCorrect={false}
                returnKeyType="go"
                onSubmitEditing={handleSubmit}
              />
            </View>
          )}

          {tab === 'signup' && (
            <View style={styles.acceptRow}>
              <TouchableOpacity
                onPress={() => setAccepted(a => !a)}
                style={[styles.checkbox, accepted && styles.checkboxOn]}
                activeOpacity={0.7}
              >
                {accepted && <Ionicons name="checkmark" size={14} color="#fff" />}
              </TouchableOpacity>
              <Text style={styles.acceptText}>
                I confirm I'm 18 or older and agree to the{' '}
                <Text style={styles.acceptLink} onPress={() => setLegalDoc('terms')}>Terms</Text>,{' '}
                <Text style={styles.acceptLink} onPress={() => setLegalDoc('privacy')}>Privacy Policy</Text>, and{' '}
                <Text style={styles.acceptLink} onPress={() => setLegalDoc('contractor')}>Independent Contractor Agreement</Text>.
              </Text>
            </View>
          )}

          <TouchableOpacity onPress={handleSubmit} disabled={!isReady || loading} activeOpacity={0.85}>
            <LinearGradient
              colors={isReady && !loading ? gradients.primary : ['#C4B5FD', '#A5B4FC']}
              style={styles.submitBtn}
            >
              {loading
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.submitText}>
                    {tab === 'signin' ? 'Sign In →'
                      : tab === 'signup' ? 'Create Account →'
                      : 'Send Reset Link →'}
                  </Text>
              }
            </LinearGradient>
          </TouchableOpacity>

          {tab === 'signin' && (
            <>
              <TouchableOpacity onPress={() => switchTab('forgot')} style={styles.forgotLink}>
                <Text style={styles.forgotLinkText}>Forgot password?</Text>
              </TouchableOpacity>
              <Text style={styles.switchHint}>
                No account?{' '}
                <Text style={styles.switchLink} onPress={() => switchTab('signup')}>Sign up free</Text>
              </Text>
            </>
          )}
          {tab === 'signup' && (
            <Text style={styles.switchHint}>
              Already have an account?{' '}
              <Text style={styles.switchLink} onPress={() => switchTab('signin')}>Sign in</Text>
            </Text>
          )}
          {tab === 'forgot' && (
            <TouchableOpacity onPress={() => switchTab('signin')} style={styles.forgotLink}>
              <Text style={styles.forgotLinkText}>← Back to sign in</Text>
            </TouchableOpacity>
          )}

          </>)}

        </View>
      </ScrollView>

      <Modal visible={!!legalDoc} animationType="slide" onRequestClose={() => setLegalDoc(null)}>
        <View style={[styles.docModal, { paddingTop: insets.top + 8 }]}>
          <View style={styles.docHeader}>
            <Text style={styles.docTitle}>{legalDoc ? (legalDocs[legalDoc]?.title || '') : ''}</Text>
            <TouchableOpacity onPress={() => setLegalDoc(null)} style={{ padding: 4 }}>
              <Ionicons name="close" size={24} color={colors.textPrimary} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20 }} showsVerticalScrollIndicator={false}>
            <Text style={styles.docBody}>{legalDoc ? (legalDocs[legalDoc]?.body || 'Loading…') : ''}</Text>
            <View style={{ height: 40 }} />
          </ScrollView>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1 },
  hero: { alignItems: 'center', paddingBottom: 48, paddingHorizontal: 24 },
  heroLogo: { marginBottom: 10 },
  heroSub: { fontSize: 15, color: 'rgba(255,255,255,0.75)', marginTop: 6, textAlign: 'center' },
  card: {
    backgroundColor: colors.surface, borderRadius: 28,
    marginHorizontal: 16, marginTop: -24, padding: 24,
    marginBottom: 32, ...shadows.md,
  },
  tabs: {
    flexDirection: 'row', backgroundColor: colors.background,
    borderRadius: 14, padding: 4, marginBottom: 24,
  },
  tabBtn: { flex: 1, paddingVertical: 10, borderRadius: 11, alignItems: 'center' },
  tabBtnActive: { backgroundColor: colors.surface, ...shadows.sm },
  tabText: { fontSize: 14, fontWeight: '600', color: colors.textMuted },
  tabTextActive: { color: colors.primary, fontWeight: '800' },
  verifyWrap: { alignItems: 'center', paddingVertical: 4 },
  verifyIcon: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  verifyTitle: { fontSize: 22, fontWeight: '900', color: colors.textPrimary, marginBottom: 8 },
  verifySub: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 21, marginBottom: 20 },
  verifyEmail: { fontWeight: '800', color: colors.textPrimary },
  forgotHeader: { alignItems: 'center', marginBottom: 20 },
  forgotTitle: { fontSize: 20, fontWeight: '900', color: colors.textPrimary, marginBottom: 6 },
  forgotSub: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  successBox: { backgroundColor: colors.successLight, borderRadius: 12, padding: 12, marginBottom: 16 },
  successText: { fontSize: 13, color: colors.success, fontWeight: '600', lineHeight: 20 },
  errorBox: { backgroundColor: '#FFF1F2', borderRadius: 12, padding: 12, marginBottom: 16 },
  errorText: { fontSize: 13, color: colors.urgent, fontWeight: '600', lineHeight: 20 },
  field: { marginBottom: 16 },
  label: {
    fontSize: 12, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8,
  },
  input: {
    backgroundColor: colors.surface, borderRadius: 14,
    borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 16, paddingVertical: 13,
    fontSize: 15, color: colors.textPrimary,
  },
  acceptRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 4, marginBottom: 4 },
  checkbox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 1,
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  acceptText: { flex: 1, fontSize: 12.5, color: colors.textSecondary, lineHeight: 18 },
  acceptLink: { color: colors.primary, fontWeight: '700' },
  docModal: { flex: 1, backgroundColor: colors.background },
  docHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  docTitle: { fontSize: 18, fontWeight: '900', color: colors.textPrimary, flex: 1 },
  docBody: { fontSize: 14, color: colors.textSecondary, lineHeight: 22 },
  submitBtn: { borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  forgotLink: { alignItems: 'center', marginTop: 16 },
  forgotLinkText: { fontSize: 14, color: colors.primary, fontWeight: '700' },
  switchHint: { textAlign: 'center', marginTop: 12, fontSize: 14, color: colors.textMuted },
  switchLink: { color: colors.primary, fontWeight: '700' },
});
