import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Modal, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { REQUIRED_SLUGS, fetchCurrentDocs, recordAcceptances } from '../lib/legal';
import { colors, gradients } from '../theme';

// Shown to returning users when the current legal docs haven't been accepted.
export default function ConsentScreen() {
  const { user, markTermsAccepted, signOut } = useAuth();
  const insets = useSafeAreaInsets();
  const [docs, setDocs] = useState(null);
  const [saving, setSaving] = useState(false);
  const [openDoc, setOpenDoc] = useState(null);

  useEffect(() => { fetchCurrentDocs().then(setDocs).catch(() => setDocs({})); }, []);

  const accept = async () => {
    setSaving(true);
    try {
      await recordAcceptances(user.id, docs || {});
      markTermsAccepted();
    } catch (_) { setSaving(false); }
  };

  const ordered = REQUIRED_SLUGS.map(s => docs?.[s]).filter(Boolean);

  return (
    <View style={styles.container}>
      <LinearGradient colors={gradients.primary} style={[styles.hero, { paddingTop: insets.top + 48 }]}>
        <Ionicons name="document-text" size={44} color="#fff" style={{ marginBottom: 10 }} />
        <Text style={styles.heroTitle}>We've updated our terms</Text>
        <Text style={styles.heroSub}>Please review and accept to keep using GoHustlr.</Text>
      </LinearGradient>

      <View style={styles.body}>
        <Text style={styles.intro}>
          By continuing you agree to our updated documents. As an Earner you operate as an independent
          contractor and are responsible for your own taxes.
        </Text>

        {docs === null ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
        ) : (
          ordered.map(d => (
            <TouchableOpacity key={d.slug} style={styles.docRow} onPress={() => setOpenDoc(d)}>
              <Text style={styles.docRowText}>{d.title}</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          ))
        )}

        <TouchableOpacity onPress={accept} disabled={saving || docs === null} activeOpacity={0.85} style={{ marginTop: 24 }}>
          <LinearGradient colors={gradients.primary} style={styles.acceptBtn}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.acceptText}>Accept & Continue</Text>}
          </LinearGradient>
        </TouchableOpacity>
        <TouchableOpacity onPress={signOut} style={styles.signOut}>
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={!!openDoc} animationType="slide" onRequestClose={() => setOpenDoc(null)}>
        <View style={[styles.docModal, { paddingTop: insets.top + 8 }]}>
          <View style={styles.docHeader}>
            <Text style={styles.docTitle}>{openDoc?.title || ''}</Text>
            <TouchableOpacity onPress={() => setOpenDoc(null)} style={{ padding: 4 }}>
              <Ionicons name="close" size={24} color={colors.textPrimary} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20 }} showsVerticalScrollIndicator={false}>
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
  hero: { alignItems: 'center', paddingBottom: 36, paddingHorizontal: 24 },
  heroTitle: { fontSize: 24, fontWeight: '900', color: '#fff', textAlign: 'center' },
  heroSub: { fontSize: 14, color: 'rgba(255,255,255,0.8)', marginTop: 6, textAlign: 'center' },
  body: { padding: 24 },
  intro: { fontSize: 14, color: colors.textSecondary, lineHeight: 21, marginBottom: 20 },
  docRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: colors.divider,
  },
  docRowText: { fontSize: 15, color: colors.textPrimary, fontWeight: '600' },
  acceptBtn: { borderRadius: 16, paddingVertical: 17, alignItems: 'center' },
  acceptText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  signOut: { paddingVertical: 16, alignItems: 'center' },
  signOutText: { fontSize: 14, color: colors.textMuted, fontWeight: '600' },
  docModal: { flex: 1, backgroundColor: colors.background },
  docHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  docTitle: { fontSize: 18, fontWeight: '900', color: colors.textPrimary, flex: 1 },
  docBody: { fontSize: 14, color: colors.textSecondary, lineHeight: 22 },
});
