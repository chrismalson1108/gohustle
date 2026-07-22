import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BADGE_DEFS } from '../data/mockData';
import { colors, radii } from '../theme';

const PREVIEW = 6;

// Earned badges only, newest-looking grid capped at PREVIEW — a wall of
// padlocks is demotivating and eats the screen as the catalogue grows. The
// locked ones (and their progress) live in the Trophy Case.
export default function BadgeGrid({ badges, onPressAll }) {
  const earned = Object.keys(BADGE_DEFS).filter(k => badges?.[k]?.unlocked);
  const total = Object.keys(BADGE_DEFS).length;
  const shown = earned.slice(0, PREVIEW);
  const overflow = earned.length - shown.length;

  if (earned.length === 0) {
    return (
      <TouchableOpacity style={styles.empty} onPress={onPressAll} activeOpacity={0.8}>
        <View style={styles.emptyIcon}>
          <Ionicons name="trophy-outline" size={22} color={colors.accentDeep} />
        </View>
        <View style={styles.emptyText}>
          <Text style={styles.emptyTitle} numberOfLines={1}>No badges yet</Text>
          <Text style={styles.emptySub} numberOfLines={2}>
            Finish your first gig to start your collection — {total} to unlock.
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
      </TouchableOpacity>
    );
  }

  return (
    <>
      <View style={styles.row}>
        {shown.map(key => {
          const def = BADGE_DEFS[key];
          return (
            <View key={key} style={styles.badge}>
              <Ionicons name={def.ion} size={22} color={colors.accentDeep} style={styles.icon} />
              <Text style={styles.label} numberOfLines={2}>{def.label}</Text>
            </View>
          );
        })}
      </View>
      <TouchableOpacity style={styles.allRow} onPress={onPressAll} activeOpacity={0.7}>
        <Text style={styles.allText} numberOfLines={1}>
          {overflow > 0 ? `+${overflow} more · ` : ''}{earned.length} of {total} unlocked
        </Text>
        <Ionicons name="chevron-forward" size={15} color={colors.textPrimary} />
      </TouchableOpacity>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  badge: {
    width: '30%',
    alignItems: 'center', justifyContent: 'flex-start', minHeight: 92,
    backgroundColor: colors.surface,
    borderRadius: radii.md, padding: 12,
  },
  icon: { marginBottom: 8 },
  label: { fontSize: 11, lineHeight: 15, fontWeight: '600', color: colors.textPrimary, textAlign: 'center' },

  allRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingVertical: 12, marginTop: 4,
  },
  allText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },

  empty: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16,
  },
  emptyIcon: {
    width: 40, height: 40, borderRadius: radii.pill,
    backgroundColor: colors.accentLight,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  emptyText: { flex: 1, minWidth: 0 },
  emptyTitle: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  emptySub: { fontSize: 12, color: colors.textSecondary, marginTop: 2, lineHeight: 17 },
});
