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
            <Text style={[styles.label, !unlocked && styles.labelLocked]} numberOfLines={1}>
              {def.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap' },
  badge: {
    width: '18%', marginRight: '2.5%', marginBottom: 12,
    alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: 14, padding: 10, borderWidth: 1.5, borderColor: colors.border,
    ...shadows.sm,
  },
  locked: { backgroundColor: colors.divider, borderColor: 'transparent', opacity: 0.5 },
  icon: { fontSize: 22, marginBottom: 4 },
  iconLocked: { opacity: 0.5 },
  label: { fontSize: 9, fontWeight: '700', color: colors.textSecondary, textAlign: 'center' },
  labelLocked: { color: colors.textMuted },
});
