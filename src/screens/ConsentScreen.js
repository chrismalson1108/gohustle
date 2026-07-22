import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Modal, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ScreenHeader from '../components/ScreenHeader';
import { useAuth } from '../context/AuthContext';
import { REQUIRED_SLUGS, fetchCurrentDocs, recordAcceptances } from '../lib/legal';
import { colors, radii, shadows } from '../theme';

// Shown to returning users when the current legal docs haven't been accepted.
export default function ConsentScreen() {
  const { user, markTermsAccepted, signOut } = useAuth();
  const insets = useSafeAreaInsets();
  const [docs, setDocs] = useState(null);
  const [saving, setSaving] = useState(false);
  const [openDoc, setOpenDoc] = useState(null);
  const [error, setError] = useState(null);

  const loadDocs = () => {
    setError(null);
    fetchCurrentDocs().then(setDocs).catch(() => {
      setDocs({});
      setError("Couldn't load the documents — check your connection and try again.");
    });
  };
  useEffect(loadDocs, []);

  const ordered = REQUIRED_SLUGS.map(s => docs?.[s]).filter(Boolean);

  const accept = async () => {
    // A failed docs fetch must NOT let the user pass the gate without accepting.
    if (!ordered.length) { setError('Documents not loaded yet — tap retry.'); return; }
    setError(null);
    setSaving(true);
    try {
      await recordAcceptances(user.id, docs || {});
      markTermsAccepted();
    } catch (_) {
      setError("Couldn't save your acceptance — check your connection and try again.");
      setSaving(false);
    }
  };

  const disabled = saving || docs === null || ordered.length === 0;

  return (
    <View style={styles.container}>
      <ScreenHeader style={styles.hero}>
        <Ionicons name="document-text-outline" size={36} color={colors.textPrimary} style={styles.heroIcon} />
        <Text style={styles.heroTitle}>We've updated our terms</Text>
        <Text style={styles.heroSub}>Please review and accept to keep using GoHustlr.</Text>
      </ScreenHeader>

      <ScrollView
        style={styles.bodyScroll}
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.intro}>
          By continuing you agree to our updated documents. As an Earner you operate as an independent
          contractor and are responsible for your own taxes.
        </Text>

        {docs === null ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
        ) : (
          ordered.map(d => (
            <TouchableOpacity key={d.slug} style={styles.docRow} onPress={() => setOpenDoc(d)} activeOpacity={0.85}>
              <Text style={styles.docRowText} numberOfLines={2}>{d.title}</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} style={styles.docRowChevron} />
            </TouchableOpacity>
          ))
        )}

        <TouchableOpacity
          onPress={accept}
          disabled={disabled}
          activeOpacity={0.85}
          style={[styles.acceptBtn, disabled && styles.acceptBtnDisabled]}
        >
          {saving
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.acceptText} numberOfLines={1}>Accept & Continue</Text>}
        </TouchableOpacity>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {docs !== null && ordered.length === 0 ? (
          <TouchableOpacity onPress={loadDocs} style={styles.signOut}>
            <Text style={[styles.signOutText, { color: colors.primary }]} numberOfLines={1}>Retry loading documents</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity onPress={signOut} style={styles.signOut}>
          <Text style={styles.signOutText} numberOfLines={1}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>

      <Modal visible={!!openDoc} animationType="slide" onRequestClose={() => setOpenDoc(null)}>
        <View style={[styles.docModal, { paddingTop: insets.top + 8 }]}>
          <View style={styles.docHeader}>
            <Text style={styles.docTitle} numberOfLines={2}>{openDoc?.title || ''}</Text>
            <TouchableOpacity onPress={() => setOpenDoc(null)} style={styles.docClose}>
              <Ionicons name="close" size={24} color={colors.textPrimary} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={styles.docScroll} showsVerticalScrollIndicator={false}>
            <Text style={styles.docBody}>{openDoc?.body || ''}</Text>
            <View style={{ height: 40 }} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  hero: { alignItems: 'center', paddingBottom: 28 },
  heroIcon: { marginTop: 32, marginBottom: 12 },
  heroTitle: {
    fontSize: 24, fontWeight: '700', color: colors.textPrimary,
    textAlign: 'center', letterSpacing: -0.4, lineHeight: 30,
  },
  heroSub: { fontSize: 14, color: colors.textSecondary, marginTop: 8, textAlign: 'center', lineHeight: 20 },
  bodyScroll: { flex: 1 },
  body: { paddingHorizontal: 20, paddingTop: 4 },
  intro: { fontSize: 14, color: colors.textSecondary, lineHeight: 21, marginBottom: 20 },
  docRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: radii.lg,
    paddingVertical: 16, paddingHorizontal: 16, marginBottom: 10,
    ...shadows.card,
  },
  docRowText: {
    fontSize: 15, color: colors.textPrimary, fontWeight: '600',
    flexShrink: 1, marginRight: 12, lineHeight: 20,
  },
  docRowChevron: { flexShrink: 0 },
  acceptBtn: {
    backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 16, paddingHorizontal: 20,
    alignItems: 'center', justifyContent: 'center', marginTop: 24,
  },
  acceptBtnDisabled: { opacity: 0.5 },
  acceptText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  errorText: { fontSize: 13, color: colors.urgent, textAlign: 'center', marginTop: 12, fontWeight: '600', lineHeight: 18 },
  signOut: { paddingVertical: 16, alignItems: 'center' },
  signOutText: { fontSize: 14, color: colors.textMuted, fontWeight: '600' },
  docModal: { flex: 1, backgroundColor: colors.background },
  docHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  docTitle: {
    fontSize: 18, fontWeight: '700', color: colors.textPrimary,
    flexShrink: 1, marginRight: 12, letterSpacing: -0.2, lineHeight: 24,
  },
  docClose: { padding: 4, flexShrink: 0 },
  docScroll: { padding: 20 },
  docBody: { fontSize: 14, color: colors.textSecondary, lineHeight: 22 },
});
