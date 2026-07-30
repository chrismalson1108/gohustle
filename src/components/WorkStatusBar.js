import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { WORK_STATUSES } from '../lib/availability';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import { colors, radii, shadows } from '../theme';

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
              {/* A drawn dot, not the status emoji. Emoji depend on a font having
                  the glyph — these rendered as "?" tofu on device — whereas a View
                  with a backgroundColor always paints. The colour is the one each
                  status already carries, and it reads as white on the active pill. */}
              <View style={[styles.dot, { backgroundColor: active ? '#fff' : s.color }]} />
              <Text
                style={[styles.pillText, active && styles.pillTextActive]}
                numberOfLines={2}
              >
                {s.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: 16,
    marginHorizontal: 16,
    marginTop: 12,
    ...shadows.card,
  },
  label: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 8 },
  row: { flexDirection: 'row', gap: 8 },
  pill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: 10,
    paddingHorizontal: 4,
    minHeight: 62,
    gap: 6,
  },
  pillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  dot: { width: 9, height: 9, borderRadius: 5 },
  pillText: { fontSize: 11, lineHeight: 14, fontWeight: '600', color: colors.textSecondary, textAlign: 'center' },
  pillTextActive: { color: '#fff' },
});
