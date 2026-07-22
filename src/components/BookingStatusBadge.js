import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii } from '../theme';

// Semantic status colors only — green = confirmed/paid, red = declined,
// amber = awaiting action, neutral ink = in-flight / cancelled.
const CONFIG = {
  pending:   { label: 'Awaiting confirmation', ion: 'time',              color: colors.accentDeep,    bg: colors.accentLight },
  confirmed: { label: 'Confirmed',             ion: 'checkmark-circle',  color: colors.success,       bg: colors.successLight },
  completed: { label: 'Pending verification',  ion: 'sync',              color: colors.textSecondary, bg: colors.background },
  verified:  { label: 'Completed & paid',      ion: 'shield-checkmark',  color: colors.success,       bg: colors.successLight },
  declined:  { label: 'Declined',              ion: 'close-circle',      color: colors.urgent,        bg: colors.urgentLight },
  cancelled: { label: 'Cancelled',             ion: 'ban',               color: colors.textSecondary, bg: colors.divider },
};

export default function BookingStatusBadge({ status, compact = false }) {
  const cfg = CONFIG[status] || CONFIG.pending;
  return (
    <View style={[styles.badge, { backgroundColor: cfg.bg }, compact && styles.compact]}>
      <Ionicons name={cfg.ion} size={13} color={cfg.color} style={{ marginRight: compact ? 0 : 5 }} />
      {!compact && (
        <Text style={[styles.label, { color: cfg.color }]} numberOfLines={1}>
          {cfg.label}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: radii.pill, paddingHorizontal: 10, paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  compact: { paddingHorizontal: 8, paddingVertical: 4 },
  label: { fontSize: 12, fontWeight: '600', flexShrink: 1 },
});
