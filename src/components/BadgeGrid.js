import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BADGE_DEFS } from '../data/mockData';
import { colors, shadows } from '../theme';

export default function BadgeGrid({ badges }) {
  return (
    <View style={styles.row}>
      {Object.entries(BADGE_DEFS).map(([key, def]) => {
        const unlocked = badges[key]?.unlocked;
        return (
          <View key={key} style={[styles.badge, !unlocked && styles.locked]}>
            <Ionicons
              name={unlocked ? def.ion : 'lock-closed'}
              size={22}
              color={unlocked ? colors.gold : colors.textMuted}
              style={styles.icon}
            />
            <Text style={[styles.label, !unlocked && styles.labelLocked]} numberOfLines={2}>
              {def.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // 3-per-row grid — at the old 18% (5-per-row) the two-word labels
  // ("First Hustle", "Speed Demon") truncated to "First…" at fontSize 9.
  // 30% cells give ~83pt of inner width so labels render in full.
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  badge: {
    width: '30%',
    alignItems: 'center', justifyContent: 'flex-start', minHeight: 92,
    backgroundColor: colors.surface,
    borderRadius: 14, padding: 10, borderWidth: 1.5, borderColor: colors.border,
    ...shadows.sm,
  },
  locked: { backgroundColor: colors.divider, borderColor: 'transparent', opacity: 0.5 },
  icon: { fontSize: 22, marginBottom: 4 },
  iconLocked: { opacity: 0.5 },
  label: { fontSize: 11, lineHeight: 14, fontWeight: '700', color: colors.textSecondary, textAlign: 'center' },
  labelLocked: { color: colors.textMuted },
});
