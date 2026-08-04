import React, { useState } from 'react';
import {
  Modal, View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Platform,
  KeyboardAvoidingView, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { submitSupportRequest, SUPPORT_CATEGORIES } from '../lib/support';
import { useUser } from '../context/UserContext';
import { colors, radii } from '../theme';
import KeyboardDoneBar, { KEYBOARD_DONE_ID } from './KeyboardDoneBar';

// In-app support form. Replaces the `mailto:` links, which never reached the
// support_tickets queue the admin console triages — see src/lib/support.js.
//
// `presetCategory` lets a caller open it already scoped (PayoutSetupScreen opens
// it on 'payment'), so the user doesn't re-explain where they were.
export default function SupportSheet({ visible, onClose, presetCategory, presetSubject }) {
  const { showToast, name: myName } = useUser();
  const [category, setCategory] = useState(presetCategory ?? null);
  const [subject, setSubject] = useState(presetSubject ?? '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ticketId, setTicketId] = useState(null);

  const reset = () => {
    setCategory(presetCategory ?? null);
    setSubject(presetSubject ?? '');
    setMessage('');
    setError('');
    setBusy(false);
    setTicketId(null);
  };
  const close = () => { reset(); onClose?.(); };

  const send = async () => {
    setError('');
    if (!message.trim()) { setError('Please describe your issue.'); return; }
    setBusy(true);
    try {
      const id = await submitSupportRequest({
        subject: subject.trim() || SUPPORT_CATEGORIES.find(c => c.key === category)?.label,
        message: message.trim(),
        category,
        name: myName ?? null,
      });
      setTicketId(id);
      showToast({ icon: '📨', title: 'Message sent', message: 'Support will reply by email.' });
    } catch (e) {
      setError(e.message || 'Could not send your message.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <KeyboardDoneBar />
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={close} />
        <View style={styles.sheet}>
          <View style={styles.handle} />

          {ticketId ? (
            <View style={styles.doneWrap}>
              <View style={styles.iconWrap}>
                <Ionicons name="checkmark-circle" size={28} color={colors.primary} />
              </View>
              <Text style={styles.title}>Message sent</Text>
              <Text style={styles.sub}>
                We've got it{ticketId ? ` (ticket #${ticketId})` : ''}. You'll get a reply by email — usually within
                a day.
              </Text>
              <PrimaryBtn label="Done" onPress={close} />
            </View>
          ) : (
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={styles.iconWrap}>
                <Ionicons name="chatbubble-ellipses" size={28} color={colors.primary} />
              </View>
              <Text style={styles.title}>Contact support</Text>
              <Text style={styles.sub}>Tell us what's going on and we'll reply by email.</Text>

              <Text style={styles.label}>What's it about?</Text>
              <View style={styles.chips}>
                {SUPPORT_CATEGORIES.map(c => (
                  <TouchableOpacity
                    key={c.key}
                    onPress={() => { setCategory(c.key === category ? null : c.key); setError(''); }}
                    activeOpacity={0.8}
                    style={[styles.chip, category === c.key && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, category === c.key && styles.chipTextActive]}>{c.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.label}>Subject</Text>
              <TextInput
                style={styles.input}
                placeholder="Short summary (optional)"
                placeholderTextColor={colors.textMuted}
                value={subject}
                onChangeText={t => { setSubject(t); setError(''); }}
                maxLength={120}
                inputAccessoryViewID={KEYBOARD_DONE_ID}
              />

              <Text style={styles.label}>What happened?</Text>
              <TextInput
                style={[styles.input, styles.textarea]}
                placeholder="Include gig names, dates, or amounts if you can — it helps us find it faster."
                placeholderTextColor={colors.textMuted}
                value={message}
                onChangeText={t => { setMessage(t); setError(''); }}
                multiline
                numberOfLines={5}
                maxLength={5000}
                textAlignVertical="top"
                inputAccessoryViewID={KEYBOARD_DONE_ID}
              />

              {!!error && <Text style={styles.error}>{error}</Text>}
              <PrimaryBtn label="Send message" busy={busy} onPress={send} />
              <TouchableOpacity onPress={close} style={styles.linkBtn}>
                <Text style={styles.linkText}>Cancel</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function PrimaryBtn({ label, busy, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={busy} activeOpacity={0.85} style={styles.btn}>
      {busy
        ? <ActivityIndicator color="#fff" />
        : <Text style={styles.btnText} numberOfLines={1}>{label}</Text>}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    paddingHorizontal: 20, paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 40 : 28,
    maxHeight: '88%',
  },
  handle: {
    width: 40, height: 4, borderRadius: radii.pill, backgroundColor: colors.border,
    marginBottom: 20, alignSelf: 'center',
  },
  doneWrap: { alignItems: 'center' },
  iconWrap: {
    width: 56, height: 56, borderRadius: radii.pill, backgroundColor: colors.background,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16, alignSelf: 'center',
  },
  title: {
    fontSize: 24, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.4,
    lineHeight: 30, textAlign: 'center', marginBottom: 8,
  },
  sub: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20, marginBottom: 20 },
  label: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 8, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: radii.pill,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  chipTextActive: { color: '#fff' },
  input: {
    width: '100%', backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, color: colors.textPrimary,
    marginBottom: 12,
  },
  textarea: { minHeight: 120, paddingTop: 14 },
  error: { color: colors.urgent, fontSize: 13, fontWeight: '600', marginTop: 4, lineHeight: 18 },
  btn: {
    width: '100%', marginTop: 12,
    backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 16, paddingHorizontal: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  linkBtn: { marginTop: 12, paddingVertical: 10, paddingHorizontal: 12, alignSelf: 'center' },
  linkText: { fontSize: 14, color: colors.primary, fontWeight: '600' },
});
