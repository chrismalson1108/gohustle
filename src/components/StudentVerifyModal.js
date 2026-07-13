import React, { useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { isEduEmail } from '../lib/school';
import { startStudentVerification, confirmStudentVerification } from '../lib/student';
import { useUser } from '../context/UserContext';
import { colors, gradients } from '../theme';

// Two-step .edu verification: enter school email → enter the emailed code.
export default function StudentVerifyModal({ visible, onClose, onVerified }) {
  const { showToast, refreshProfile } = useUser();
  const [step, setStep] = useState('email'); // 'email' | 'code' | 'done'
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reset = () => { setStep('email'); setEmail(''); setCode(''); setError(''); setBusy(false); };
  const close = () => { reset(); onClose?.(); };

  const sendCode = async () => {
    setError('');
    if (!isEduEmail(email)) { setError('Enter a valid school (.edu) email.'); return; }
    setBusy(true);
    try {
      await startStudentVerification(email.trim().toLowerCase());
      setStep('code');
    } catch (e) {
      setError(e.code === 'email_not_configured'
        ? 'Student verification email isn’t set up yet. (Admin: add RESEND_API_KEY.)'
        : e.message || 'Could not send the code.');
    } finally { setBusy(false); }
  };

  const confirm = async () => {
    setError('');
    if (!code.trim()) { setError('Enter the 6-digit code.'); return; }
    setBusy(true);
    try {
      await confirmStudentVerification(email.trim().toLowerCase(), code.trim());
      await refreshProfile();
      setStep('done');
      showToast({ icon: '🎓', title: 'Verified Student!', message: 'Your school email is confirmed.' });
      onVerified?.();
    } catch (e) {
      setError(e.message || 'That code didn’t match.');
    } finally { setBusy(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={close} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.iconWrap}>
            <Ionicons name="school" size={28} color={colors.primary} />
          </View>

          {step === 'email' && (
            <>
              <Text style={styles.title}>Verify your student status</Text>
              <Text style={styles.sub}>We’ll email a code to your school address to confirm you’re a student. Adds a Verified Student badge to your profile.</Text>
              <TextInput
                style={styles.input}
                placeholder="you@school.edu"
                placeholderTextColor={colors.textMuted}
                value={email}
                onChangeText={t => { setEmail(t); setError(''); }}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
              />
              {!!error && <Text style={styles.error}>{error}</Text>}
              <PrimaryBtn label="Send code" busy={busy} onPress={sendCode} />
            </>
          )}

          {step === 'code' && (
            <>
              <Text style={styles.title}>Enter your code</Text>
              <Text style={styles.sub}>We sent a 6-digit code to {email}. It expires in 15 minutes.</Text>
              <TextInput
                style={[styles.input, styles.codeInput]}
                placeholder="123456"
                placeholderTextColor={colors.textMuted}
                value={code}
                onChangeText={t => { setCode(t.replace(/[^0-9]/g, '')); setError(''); }}
                keyboardType="number-pad"
                maxLength={6}
              />
              {!!error && <Text style={styles.error}>{error}</Text>}
              <PrimaryBtn label="Verify" busy={busy} onPress={confirm} />
              <TouchableOpacity onPress={() => setStep('email')} style={styles.linkBtn}>
                <Text style={styles.linkText}>Use a different email</Text>
              </TouchableOpacity>
            </>
          )}

          {step === 'done' && (
            <>
              <Text style={styles.title}>You’re verified! 🎓</Text>
              <Text style={styles.sub}>Your Verified Student badge is now live. Posters and earners will see it.</Text>
              <PrimaryBtn label="Done" onPress={close} />
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function PrimaryBtn({ label, busy, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={busy} activeOpacity={0.85} style={{ width: '100%', marginTop: 8 }}>
      <LinearGradient colors={gradients.primary} style={styles.btn}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>{label}</Text>}
      </LinearGradient>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: Platform.OS === 'ios' ? 40 : 28, alignItems: 'center' },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 16 },
  iconWrap: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  title: { fontSize: 20, fontWeight: '900', color: colors.textPrimary, textAlign: 'center', marginBottom: 8 },
  sub: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20, marginBottom: 18 },
  input: { width: '100%', backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1.5, borderColor: colors.border, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, color: colors.textPrimary },
  codeInput: { textAlign: 'center', letterSpacing: 8, fontSize: 22, fontWeight: '800' },
  error: { color: colors.urgent, fontSize: 13, fontWeight: '600', marginTop: 8, alignSelf: 'flex-start' },
  btn: { borderRadius: 16, paddingVertical: 16, alignItems: 'center' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  linkBtn: { marginTop: 14 },
  linkText: { fontSize: 14, color: colors.textMuted, fontWeight: '600' },
});
