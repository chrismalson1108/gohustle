import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

const CONFIG = {
  pending:   { label: 'Awaiting Confirmation', icon: '⏳', color: '#D97706', bg: '#FEF3C7' },
  confirmed: { label: 'Confirmed',             icon: '✅', color: '#059669', bg: '#D1FAE5' },
  completed: { label: 'Pending Verification',  icon: '🔄', color: '#4F46E5', bg: '#EDE9FE' },
  verified:  { label: 'Completed & Paid',      icon: '💚', color: '#059669', bg: '#D1FAE5' },
  declined:  { label: 'Declined',              icon: '❌', color: '#DC2626', bg: '#FEE2E2' },
  cancelled: { label: 'Cancelled',             icon: '🚫', color: '#9CA3AF', bg: '#F3F4F6' },
};

export default function BookingStatusBadge({ status, compact = false }) {
  const cfg = CONFIG[status] || CONFIG.pending;
  return (
    <View style={[styles.badge, { backgroundColor: cfg.bg }, compact && styles.compact]}>
      <Text style={styles.icon}>{cfg.icon}</Text>
      {!compact && <Text style={[styles.label, { color: cfg.color }]}>{cfg.label}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  compact: { paddingHorizontal: 7, paddingVertical: 4 },
  icon: { fontSize: 13, marginRight: 5 },
  label: { fontSize: 12, fontWeight: '700' },
});
