import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { studentTrustLabel } from '../lib/school';
import { colors, radii } from '../theme';

// Compact "Verified Student / Alumni" pill. Renders nothing if not verified.
export default function StudentBadge({ profile, compact = false, style }) {
  const label = studentTrustLabel(profile);
  if (!label) return null;
  return (
    <View style={[styles.badge, compact && styles.compact, style]}>
      <Ionicons name="school" size={compact ? 10 : 12} color={colors.primary} style={{ marginRight: 4, flexShrink: 0 }} />
      <Text style={[styles.text, compact && styles.compactText]} numberOfLines={1}>
        {compact ? 'Student' : label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    backgroundColor: colors.primaryLight, borderRadius: radii.sm,
    paddingHorizontal: 8, paddingVertical: 3,
    // RN's default flexShrink is 0 — without this the pill would push siblings
    // (rating, spacer) off the row instead of ellipsizing its own label.
    flexShrink: 1,
  },
  compact: { paddingHorizontal: 6, paddingVertical: 2 },
  text: { fontSize: 11, fontWeight: '600', color: colors.primary, flexShrink: 1 },
  compactText: { fontSize: 10 },
});
