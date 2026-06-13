import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const CONFIG = {
  pending:   { label: 'Awaiting Confirmation', ion: 'time',              color: '#D97706', bg: '#FEF3C7' },
  confirmed: { label: 'Confirmed',             ion: 'checkmark-circle',  color: '#059669', bg: '#D1FAE5' },
  completed: { label: 'Pending Verification',  ion: 'sync',              color: '#4F46E5', bg: '#EDE9FE' },
  verified:  { label: 'Completed & Paid',      ion: 'shield-checkmark',  color: '#059669', bg: '#D1FAE5' },
  declined:  { label: 'Declined',              ion: 'close-circle',      color: '#DC2626', bg: '#FEE2E2' },
  cancelled: { label: 'Cancelled',             ion: 'ban',               color: '#9CA3AF', bg: '#F3F4F6' },
};

export default function BookingStatusBadge({ status, compact = false }) {
  const cfg = CONFIG[status] || CONFIG.pending;
  return (
    <View style={[styles.badge, { backgroundColor: cfg.bg }, compact && styles.compact]}>
      <Ionicons name={cfg.ion} size={13} color={cfg.color} style={{ marginRight: compact ? 0 : 5 }} />
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
