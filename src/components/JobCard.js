import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, shadows } from '../theme';
import { CATEGORY_COLORS } from '../data/mockData';
import { useHaptic } from '../hooks/useHaptic';
import RatingStars from './RatingStars';

export default function JobCard({ job, onPress }) {
  const haptic = useHaptic();
  const catColor = CATEGORY_COLORS[job.category] || colors.primary;
  const estPay = job.payType === 'hourly'
    ? `$${job.pay * (job.estimatedHours || 1)}–${job.pay * (job.estimatedHours || 1) + job.pay} est.`
    : `$${job.pay} flat`;

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => { haptic.light(); onPress(); }}
      activeOpacity={0.82}
    >
      <View style={[styles.accent, { backgroundColor: catColor }]} />
      <View style={styles.body}>
        {job.urgent && (
          <View style={styles.urgentRow}>
            <View style={styles.urgentBadge}>
              <Text style={styles.urgentText}>⚡ URGENT</Text>
            </View>
          </View>
        )}
        <View style={styles.headerRow}>
          <View style={[styles.catBadge, { backgroundColor: catColor + '20' }]}>
            <Text style={[styles.catText, { color: catColor }]}>{job.category}</Text>
          </View>
          <Text style={styles.time}>{job.postedAt}</Text>
        </View>
        <Text style={styles.title} numberOfLines={2}>{job.title}</Text>
        <Text style={styles.desc} numberOfLines={2}>{job.description}</Text>
        <View style={styles.footer}>
          <View style={styles.payBadge}>
            <Text style={styles.payText}>{estPay}</Text>
          </View>
          <Text style={styles.loc} numberOfLines={1}>📍 {job.location}</Text>
        </View>
        <View style={styles.posterRow}>
          <View style={styles.posterAvatar}>
            <Text style={styles.posterAvatarText}>{job.poster.avatarInitial}</Text>
          </View>
          <Text style={styles.posterName}>{job.poster.name}</Text>
          {job.poster.verified && <Text style={styles.verified}>✓</Text>}
          <View style={styles.spacer} />
          <RatingStars rating={job.poster.rating} size={12} />
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    marginHorizontal: 16,
    marginBottom: 14,
    flexDirection: 'row',
    overflow: 'hidden',
    ...shadows.card,
  },
  accent: { width: 5 },
  body: { flex: 1, padding: 16 },
  urgentRow: { marginBottom: 8 },
  urgentBadge: {
    backgroundColor: colors.urgentLight, borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start',
  },
  urgentText: { color: colors.urgent, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  catBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  catText: { fontSize: 11, fontWeight: '700' },
  time: { fontSize: 11, color: colors.textMuted },
  title: { fontSize: 16, fontWeight: '800', color: colors.textPrimary, marginBottom: 5, lineHeight: 22 },
  desc: { fontSize: 13, color: colors.textSecondary, lineHeight: 19, marginBottom: 12 },
  footer: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  payBadge: {
    backgroundColor: colors.accentLight, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 5, marginRight: 10,
  },
  payText: { color: colors.success, fontWeight: '800', fontSize: 13 },
  loc: { fontSize: 12, color: colors.textSecondary, flex: 1 },
  posterRow: { flexDirection: 'row', alignItems: 'center', paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.divider },
  posterAvatar: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center', marginRight: 6,
  },
  posterAvatarText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  posterName: { fontSize: 12, fontWeight: '600', color: colors.textSecondary, marginRight: 4 },
  verified: { fontSize: 11, color: colors.success },
  spacer: { flex: 1 },
});
