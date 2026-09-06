import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, Switch, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import { colors, radii, shadows } from '../theme';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import { getNotificationPrefs, saveNotificationPref, NOTIF_CATEGORIES } from '../lib/notifications';

// Dedicated notification-preferences screen (reached from Profile → Preferences).
// Per-category cards with clearly-labeled Push/Email switches — no cramped columns.
//
// When the load FAILS the switches are not rendered at all. Showing the defaults
// after a failed read told the user their opt-outs were gone, and the toggle that
// followed used to write the whole row and make that true.
export default function NotificationSettingsScreen() {
  const { showToast } = useUser();
  const haptic = useHaptic();
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(() => {
    getNotificationPrefs()
      .then((p) => { setPrefs(p); setLoadFailed(false); })
      .catch(() => { setPrefs(null); setLoadFailed(true); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const retry = () => { setLoading(true); load(); };

  // Per-channel toggle. Saves immediately, optimistic with revert on failure.
  // Only the one key is written — see saveNotificationPref.
  const toggle = (key) => async (value) => {
    haptic.selection();
    const previous = prefs;
    setPrefs({ ...prefs, [key]: value });
    try {
      await saveNotificationPref(key, value);
    } catch (_) {
      setPrefs(previous); // revert
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

  if (loadFailed || !prefs) {
    return (
      <View style={styles.loading}>
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Couldn&apos;t load your delivery settings</Text>
          <Text style={styles.errorBody}>
            Nothing has changed — your saved choices are untouched. Check your connection and try again.
          </Text>
          <Pressable onPress={retry} style={styles.retry} accessibilityRole="button">
            <Text style={styles.retryLabel}>Try again</Text>
          </Pressable>
        </View>
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
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, padding: 20 },
  errorCard: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    padding: 20, width: '100%', ...shadows.card,
  },
  errorTitle: { fontSize: 16, lineHeight: 21, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.2 },
  errorBody: { fontSize: 14, lineHeight: 20, color: colors.textSecondary, marginTop: 8 },
  retry: {
    marginTop: 16, alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center',
    paddingHorizontal: 18, borderRadius: radii.pill, backgroundColor: colors.primary,
  },
  retryLabel: { fontSize: 15, fontWeight: '600', color: '#fff' },
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
