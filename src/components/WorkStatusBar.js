import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { WORK_STATUSES } from '../lib/availability';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import { colors, shadows } from '../theme';

// Compact "ready to work / busy / away / offline" toggle. Mirrors the web bar.
export default function WorkStatusBar() {
  const { workStatus, setWorkStatus, showToast } = useUser();
  const haptic = useHaptic();

  const pick = (s) => {
    if (s.id === workStatus) return;
    haptic?.selection?.();
    setWorkStatus(s.id);
    showToast?.({ icon: '📣', title: 'Status updated', message: `You're now "${s.label}".` });
  };

  return (
    <View style={styles.card}>
      <Text style={styles.label}>Your work status</Text>
      <View style={styles.row}>
        {WORK_STATUSES.map((s) => {
          const active = s.id === workStatus;
          return (
            <TouchableOpacity
              key={s.id}
              style={[styles.pill, active && styles.pillActive]}
              onPress={() => pick(s)}
              activeOpacity={0.8}
            >
              <Text style={styles.emoji}>{s.emoji}</Text>
              <Text style={[styles.pillText, active && styles.pillTextActive]}>{s.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 18, padding: 12, marginHorizontal: 16, marginTop: 12, ...shadows.card },
  label: { fontSize: 12, fontWeight: '800', color: colors.textSecondary, marginBottom: 8, marginLeft: 2 },
  row: { flexDirection: 'row', gap: 6 },
  pill: { flex: 1, alignItems: 'center', backgroundColor: colors.background, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 2, gap: 2 },
  pillActive: { backgroundColor: colors.primary },
  emoji: { fontSize: 15 },
  pillText: { fontSize: 10.5, fontWeight: '800', color: colors.textSecondary, textAlign: 'center' },
  pillTextActive: { color: '#fff' },
});
