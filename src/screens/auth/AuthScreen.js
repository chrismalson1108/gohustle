import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, Keyboard, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Logo from '../../components/Logo';
import ScreenHeader from '../../components/ScreenHeader';
import { useAuth } from '../../context/AuthContext';
import { fetchCurrentDocs } from '../../lib/legal';
import { colors, radii, shadows } from '../../theme';

// Password field with a show/hide (eye) toggle. Encapsulates its own reveal state.
function PasswordField({ label, value, onChangeText, placeholder, returnKeyType, onSubmitEditing, textContentType, autoComplete }) {
  const [show, setShow] = useState(false);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.pwWrap}>
        <TextInput
          style={[styles.input, styles.pwInput]}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={!show}
          autoCapitalize="none"
          autoCorrect={false}
          textContentType={textContentType}
          autoComplete={autoComplete}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
        />
        <TouchableOpacity
          onPress={() => setShow(s => !s)}
          style={styles.pwEye}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel={show ? 'Hide password' : 'Show password'}
        >
          <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={22} color={colors.textMuted} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// tab: 'signin' | 'signup' | 'forgot'
export default function AuthScreen() {
  const { signIn, signInWithGoogle, signInWithApple, signUp, resetPassword, resendConfirmation, clearPending, pendingEmail, authError, clearError } = useAuth();
  const insets = useSafeAreaInsets();
  const [tab, setTab]           = useState('signin');
  const [googleLoading, setGoogleLoading] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);

  // Apple Sign In is iOS 13+ only; hide the button where it isn't available.
  useEffect(() => { AppleAuthentication.isAvailableAsync().then(setAppleAvailable).catch(() => {}); }, []);
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

  const handleGoogle = async () => {
    Keyboard.dismiss();
    setLocalError('');
    setSuccessMsg('');
    setGoogleLoading(true);
    await signInWithGoogle();
    // On success onAuthStateChange swaps this screen out; on cancel/error we stay.
    setGoogleLoading(false);
  };

  const handleApple = async () => {
    Keyboard.dismiss();
    setLocalError('');
    setSuccessMsg('');
    await signInWithApple();
    // On success onAuthStateChange swaps this screen out; on cancel/error we stay.
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

        <ScreenHeader style={styles.hero}>
          <Logo height={64} style={styles.heroLogo} />
          <Text style={styles.heroSub}>Get paid to hustle. Post gigs. Earn money.</Text>
        </ScreenHeader>

        <View style={styles.card}>

          {showVerify ? (
            <View style={styles.verifyWrap}>
              <View style={styles.verifyIcon}>
                <Ionicons name="mail-unread" size={38} color={colors.textPrimary} />
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

              <TouchableOpacity
                onPress={() => { clearPending(); setResendMsg(''); switchTab('signin'); }}
                activeOpacity={0.85}
                style={styles.submitBtn}
              >
                <Text style={styles.submitText} numberOfLines={1}>I've confirmed — Sign in</Text>
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
                  <Text style={[styles.tabText, tab === t && styles.tabTextActive]} numberOfLines={1}>
                    {t === 'signin' ? 'Sign in' : 'Create account'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {tab === 'forgot' && (
            <View style={styles.forgotHeader}>
              <Text style={styles.forgotTitle}>Reset password</Text>
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
              <Text style={styles.label}>Your name</Text>
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
            <PasswordField
              label="Password"
              placeholder={tab === 'signup' ? 'At least 8 characters' : '••••••••'}
              value={password}
              onChangeText={setPassword}
              textContentType={tab === 'signup' ? 'newPassword' : 'password'}
              autoComplete={tab === 'signup' ? 'password-new' : 'password'}
              returnKeyType={tab === 'signin' ? 'go' : 'next'}
              onSubmitEditing={tab === 'signin' ? handleSubmit : undefined}
            />
          )}

          {tab === 'signup' && (
            <PasswordField
              label="Confirm password"
              placeholder="Re-enter password"
              value={confirmPw}
              onChangeText={setConfirmPw}
              textContentType="newPassword"
              autoComplete="password-new"
              returnKeyType="next"
            />
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

          <TouchableOpacity
            onPress={handleSubmit}
            disabled={!isReady || loading}
            activeOpacity={0.85}
            style={[styles.submitBtn, (!isReady || loading) && styles.submitBtnDisabled]}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.submitText} numberOfLines={1}>
                  {tab === 'signin' ? 'Sign in'
                    : tab === 'signup' ? 'Create account'
                    : 'Send reset link'}
                </Text>
            }
          </TouchableOpacity>

          {tab !== 'forgot' && (
            <>
              <View style={styles.dividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>or</Text>
                <View style={styles.dividerLine} />
              </View>
              {appleAvailable && (
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
                  buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                  cornerRadius={radii.md}
                  style={styles.appleBtn}
                  onPress={handleApple}
                />
              )}
              <TouchableOpacity
                onPress={handleGoogle}
                disabled={googleLoading || loading}
                activeOpacity={0.85}
                style={styles.googleBtn}
              >
                {googleLoading
                  ? <ActivityIndicator color={colors.primary} />
                  : <>
                      <Ionicons name="logo-google" size={20} color="#4285F4" style={{ marginRight: 10 }} />
                      <Text style={styles.googleText} numberOfLines={1}>Continue with Google</Text>
                    </>}
              </TouchableOpacity>
            </>
          )}

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
            <Text style={styles.docTitle} numberOfLines={1}>{legalDoc ? (legalDocs[legalDoc]?.title || '') : ''}</Text>
            <TouchableOpacity onPress={() => setLegalDoc(null)} style={styles.docClose}>
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
  hero: { alignItems: 'center', paddingBottom: 20 },
  heroLogo: { marginTop: 24, marginBottom: 8 },
  heroSub: {
    fontSize: 15, color: colors.textSecondary, lineHeight: 21,
    marginTop: 4, textAlign: 'center',
  },
  card: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    marginHorizontal: 20, padding: 16, marginBottom: 32,
    ...shadows.card,
  },
  tabs: {
    flexDirection: 'row', backgroundColor: colors.background,
    borderRadius: radii.pill, padding: 4, marginBottom: 24,
  },
  tabBtn: {
    flex: 1, paddingVertical: 10, paddingHorizontal: 8,
    borderRadius: radii.pill, alignItems: 'center',
  },
  tabBtnActive: { backgroundColor: colors.surface, ...shadows.sm },
  tabText: { fontSize: 14, fontWeight: '600', color: colors.textMuted },
  tabTextActive: { color: colors.primary, fontWeight: '700' },
  verifyWrap: { alignItems: 'center', paddingVertical: 4 },
  verifyIcon: {
    width: 72, height: 72, borderRadius: radii.pill, backgroundColor: colors.background,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  verifyTitle: {
    fontSize: 22, fontWeight: '700', color: colors.textPrimary,
    letterSpacing: -0.4, marginBottom: 8,
  },
  verifySub: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 21, marginBottom: 20 },
  verifyEmail: { fontWeight: '700', color: colors.textPrimary },
  forgotHeader: { alignItems: 'center', marginBottom: 20 },
  forgotTitle: {
    fontSize: 20, fontWeight: '700', color: colors.textPrimary,
    letterSpacing: -0.4, marginBottom: 6,
  },
  forgotSub: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  successBox: {
    alignSelf: 'stretch', backgroundColor: colors.successLight,
    borderRadius: radii.md, padding: 12, marginBottom: 16,
  },
  successText: { fontSize: 13, color: colors.success, fontWeight: '600', lineHeight: 19 },
  errorBox: {
    alignSelf: 'stretch', backgroundColor: colors.urgentLight,
    borderRadius: radii.md, padding: 12, marginBottom: 16,
  },
  errorText: { fontSize: 13, color: colors.urgent, fontWeight: '600', lineHeight: 19 },
  field: { marginBottom: 16 },
  label: {
    fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 8,
  },
  input: {
    backgroundColor: colors.background, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 16, paddingVertical: 14,
    fontSize: 15, color: colors.textPrimary,
  },
  pwWrap: { position: 'relative', justifyContent: 'center' },
  pwInput: { paddingRight: 48 },
  pwEye: { position: 'absolute', right: 12, padding: 4 },
  dividerRow: { flexDirection: 'row', alignItems: 'center', marginTop: 20, marginBottom: 4 },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.divider },
  dividerText: {
    marginHorizontal: 12, fontSize: 12, fontWeight: '500', color: colors.textMuted,
  },
  googleBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface, borderRadius: radii.md,
    paddingVertical: 14, paddingHorizontal: 16,
    borderWidth: 1, borderColor: colors.border, marginTop: 12,
  },
  googleText: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
  appleBtn: { width: '100%', height: 48, marginTop: 12 },
  acceptRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 4, marginBottom: 4 },
  checkbox: {
    width: 22, height: 22, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 1,
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  acceptText: { flex: 1, fontSize: 13, color: colors.textSecondary, lineHeight: 19 },
  acceptLink: { color: colors.primary, fontWeight: '600' },
  docModal: { flex: 1, backgroundColor: colors.background },
  docHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: colors.divider,
  },
  docTitle: {
    fontSize: 18, fontWeight: '700', color: colors.textPrimary,
    letterSpacing: -0.3, flex: 1, marginRight: 12,
  },
  docClose: { padding: 4, flexShrink: 0 },
  docBody: { fontSize: 14, color: colors.textSecondary, lineHeight: 22 },
  submitBtn: {
    alignSelf: 'stretch', backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 16, paddingHorizontal: 20,
    alignItems: 'center', justifyContent: 'center', marginTop: 8,
  },
  submitBtnDisabled: { backgroundColor: colors.textMuted },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  forgotLink: { alignItems: 'center', marginTop: 16 },
  forgotLinkText: { fontSize: 14, color: colors.primary, fontWeight: '600' },
  switchHint: { textAlign: 'center', marginTop: 12, fontSize: 14, color: colors.textMuted },
  switchLink: { color: colors.primary, fontWeight: '600' },
});
