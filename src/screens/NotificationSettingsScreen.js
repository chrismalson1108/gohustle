import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, Switch, StyleSheet, ActivityIndicator } from 'react-native';
import { colors, radii, shadows } from '../theme';
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
          <Text style={styles.catLabel} numberOfLines={2}>{cat.label}</Text>
          <Text style={styles.catHint}>{cat.hint}</Text>
          <View style={styles.togglesRow}>
            <View style={styles.toggleItem}>
              <Switch
                value={prefs[`${cat.key}_push`]}
                onValueChange={toggle(`${cat.key}_push`)}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor="#fff"
              />
              <Text style={styles.toggleLabel} numberOfLines={1}>Push</Text>
            </View>
            <View style={styles.toggleItem}>
              <Switch
                value={prefs[`${cat.key}_email`]}
                onValueChange={toggle(`${cat.key}_email`)}
                trackColor={{ false: colors.border, true: colors.primary }}
                thumbColor="#fff"
              />
              <Text style={styles.toggleLabel} numberOfLines={1}>Email</Text>
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
  intro: { fontSize: 14, color: colors.textSecondary, lineHeight: 20, marginBottom: 16 },
  card: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    padding: 16, marginBottom: 12, ...shadows.card,
  },
  catLabel: { fontSize: 16, lineHeight: 21, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.2 },
  catHint: { fontSize: 13, lineHeight: 18, color: colors.textMuted, marginTop: 4 },
  togglesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 24, marginTop: 16 },
  toggleItem: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  toggleLabel: { fontSize: 14, lineHeight: 19, fontWeight: '500', color: colors.textSecondary, flexShrink: 1 },
});
