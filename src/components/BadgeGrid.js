import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BADGE_DEFS } from '../data/mockData';
import { colors, radii } from '../theme';

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
              color={unlocked ? colors.accentDeep : colors.textMuted}
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
    borderRadius: radii.md, padding: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  // Locked reads as "empty slot" via the cream fill + muted lock glyph. No
  // opacity — it dropped the muted label to ~1.9:1 contrast on cream.
  locked: { backgroundColor: colors.background },
  icon: { marginBottom: 8 },
  label: { fontSize: 11, lineHeight: 15, fontWeight: '600', color: colors.textSecondary, textAlign: 'center' },
  labelLocked: { color: colors.textMuted },
});
