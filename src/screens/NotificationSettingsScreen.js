import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, Switch, StyleSheet, ActivityIndicator } from 'react-native';
import { colors, shadows } from '../theme';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import { getNotificationPrefs, saveNotificationPrefs, DEFAULT_NOTIF_PREFS, NOTIF_CATEGORIES } from '../lib/notifications';

// Dedicated notification-preferences screen (reached from Profile → Preferences).
// Per-category cards with clearly-labeled Push/Email switches — no cramped columns.
export default function NotificationSettingsScreen() {
  const { showToast } = useUser();
  const haptic = useHaptic();
  const [prefs, setPrefs] = useState(DEFAULT_NOTIF_PREFS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getNotificationPrefs().then(setPrefs).catch(() => {}).finally(() => setLoading(false));
  }, []);

  // Per-channel toggle. Saves immediately, optimistic with revert on failure.
  const toggle = (key) => async (value) => {
    haptic.selection();
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    try {
      await saveNotificationPrefs(next);
    } catch (_) {
      setPrefs(prefs); // revert
      showToast({ icon: '⚠️', title: "Couldn't update", message: 'Please try again.' });
    }
  };

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
      <Text style={styles.intro}>
        In-app alerts always show up in your Alerts inbox. Push and email delivery are optional and can be set per category below.
      </Text>

      {NOTIF_CATEGORIES.map((cat) => (
        <View key={cat.key} style={styles.card}>
          <Text style={styles.catLabel}>{cat.label}</Text>
          <Text style={styles.catHint}>{cat.hint}</Text>
          <View style={styles.togglesRow}>
            <View style={styles.toggleItem}>
              <Switch
                value={prefs[`${cat.key}_push`]}
                onValueChange={toggle(`${cat.key}_push`)}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor="#fff"
              />
              <Text style={styles.toggleLabel}>Push</Text>
            </View>
            <View style={styles.toggleItem}>
              <Switch
                value={prefs[`${cat.key}_email`]}
                onValueChange={toggle(`${cat.key}_email`)}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor="#fff"
              />
              <Text style={styles.toggleLabel}>Email</Text>
            </View>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  intro: { fontSize: 13, color: colors.textSecondary, lineHeight: 19, marginBottom: 16 },
  card: {
    backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border,
    padding: 16, marginBottom: 12, ...shadows.sm,
  },
  catLabel: { fontSize: 15, fontWeight: '800', color: colors.textPrimary },
  catHint: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  togglesRow: { flexDirection: 'row', gap: 28, marginTop: 14 },
  toggleItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toggleLabel: { fontSize: 14, fontWeight: '700', color: colors.textSecondary },
});
