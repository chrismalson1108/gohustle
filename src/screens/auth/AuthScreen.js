import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, Keyboard,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../context/AuthContext';
import { colors, gradients, shadows } from '../../theme';

// tab: 'signin' | 'signup' | 'forgot'
export default function AuthScreen() {
  const { signIn, signUp, resetPassword, authError, clearError } = useAuth();
  const insets = useSafeAreaInsets();
  const [tab, setTab]           = useState('signin');
  const [name, setName]         = useState('');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [loading, setLoading]   = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [localError, setLocalError] = useState('');

  const switchTab = (t) => {
    setTab(t);
    clearError();
    setSuccessMsg('');
    setLocalError('');
    setName('');
    setEmail('');
    setPassword('');
    setConfirmPw('');
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
      if (password.length < 6) { setLocalError('Password must be at least 6 characters'); return; }
      if (password !== confirmPw) { setLocalError('Passwords do not match'); return; }
    }

    setLoading(true);
    setSuccessMsg('');
    if (tab === 'signin') {
      await signIn(email.trim(), password);
    } else {
      const ok = await signUp(email.trim(), password, name.trim());
      if (ok) {
        setSuccessMsg('Account created! Check your email to confirm, then sign in.');
        switchTab('signin');
      }
    }
    setLoading(false);
  };

  const isReady = tab === 'forgot'
    ? !!email
    : email && password && (tab === 'signin' || (name && confirmPw));

  const errorMsg = localError || authError;

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">

        <LinearGradient colors={gradients.primary} style={[styles.hero, { paddingTop: insets.top + 40 }]}>
          <Text style={styles.heroEmoji}>⚡</Text>
          <Text style={styles.heroTitle}>GoHustlr</Text>
          <Text style={styles.heroSub}>Get paid to hustle. Post gigs. Earn money.</Text>
        </LinearGradient>

        <View style={styles.card}>

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
              <Text style={styles.forgotTitle}>🔑 Reset Password</Text>
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
                returnKeyType="go"
                onSubmitEditing={handleSubmit}
              />
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

        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1 },
  hero: { alignItems: 'center', paddingBottom: 48, paddingHorizontal: 24 },
  heroEmoji: { fontSize: 52, marginBottom: 8 },
  heroTitle: { fontSize: 38, fontWeight: '900', color: '#fff', letterSpacing: -1 },
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
  forgotHeader: { alignItems: 'center', marginBottom: 20 },
  forgotTitle: { fontSize: 20, fontWeight: '900', color: colors.textPrimary, marginBottom: 6 },
  forgotSub: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },
  successBox: { backgroundColor: colors.accentLight, borderRadius: 12, padding: 12, marginBottom: 16 },
  successText: { fontSize: 13, color: colors.success, fontWeight: '600', lineHeight: 20 },
  errorBox: { backgroundColor: '#FFF1F2', borderRadius: 12, padding: 12, marginBottom: 16 },
  errorText: { fontSize: 13, color: colors.urgent, fontWeight: '600', lineHeight: 20 },
  field: { marginBottom: 16 },
  label: {
    fontSize: 12, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8,
  },
  input: {
    backgroundColor: colors.background, borderRadius: 14,
    borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 16, paddingVertical: 13,
    fontSize: 15, color: colors.textPrimary,
  },
  submitBtn: { borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  forgotLink: { alignItems: 'center', marginTop: 16 },
  forgotLinkText: { fontSize: 14, color: colors.primary, fontWeight: '700' },
  switchHint: { textAlign: 'center', marginTop: 12, fontSize: 14, color: colors.textMuted },
  switchLink: { color: colors.primary, fontWeight: '700' },
});
