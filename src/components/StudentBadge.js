import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { studentTrustLabel } from '../lib/school';
import { colors } from '../theme';

// Compact "Verified Student / Alumni" pill. Renders nothing if not verified.
export default function StudentBadge({ profile, compact = false, style }) {
  const label = studentTrustLabel(profile);
  if (!label) return null;
  return (
    <View style={[styles.badge, compact && styles.compact, style]}>
      <Ionicons name="school" size={compact ? 10 : 12} color={colors.primary} style={{ marginRight: compact ? 3 : 4 }} />
      <Text style={[styles.text, compact && styles.compactText]}>{compact ? 'Student' : label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.primaryLight, borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 2.5,
  },
  compact: { paddingHorizontal: 5, paddingVertical: 2 },
  text: { fontSize: 11, fontWeight: '800', color: colors.primary },
  compactText: { fontSize: 10 },
});
