import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, shadows } from '../theme';
import { CATEGORY_COLORS } from '../data/mockData';
import { useHaptic } from '../hooks/useHaptic';
import RatingStars from './RatingStars';
import Avatar from './Avatar';
import StudentBadge from './StudentBadge';

const BOOKING_PILL = {
  pending:   { label: 'Applied — Pending',        ion: 'time',              bg: '#FFF7ED', text: '#D97706' },
  confirmed: { label: 'Confirmed — In Progress',  ion: 'checkmark-circle',  bg: '#ECFDF5', text: '#059669' },
  completed: { label: 'Awaiting Verification',    ion: 'sync',              bg: '#EFF6FF', text: '#2563EB' },
  verified:  { label: 'Completed',                ion: 'heart',             bg: '#F0FDF4', text: '#16A34A' },
  declined:  { label: 'Declined',                 ion: 'close-circle',      bg: '#FEF2F2', text: '#DC2626' },
};

const RECUR_LABEL = { weekly: 'Weekly', biweekly: 'Biweekly', monthly: 'Monthly' };

export default function JobCard({ job, onPress, bookingStatus, distanceLabel }) {
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
        {job.photos?.length > 0 && (
          <Image source={{ uri: job.photos[0] }} style={styles.cover} />
        )}
        {bookingStatus && BOOKING_PILL[bookingStatus] && (
          <View style={[styles.bookingPill, { backgroundColor: BOOKING_PILL[bookingStatus].bg }]}>
            <Ionicons name={BOOKING_PILL[bookingStatus].ion} size={13} color={BOOKING_PILL[bookingStatus].text} style={{ marginRight: 5 }} />
            <Text style={[styles.bookingPillText, { color: BOOKING_PILL[bookingStatus].text }]}>
              {BOOKING_PILL[bookingStatus].label}
            </Text>
          </View>
        )}
        {job.urgent && (
          <View style={styles.urgentRow}>
            <View style={styles.urgentBadge}>
              <Ionicons name="flash" size={11} color={colors.urgent} style={{ marginRight: 3 }} />
              <Text style={styles.urgentText}>URGENT</Text>
            </View>
          </View>
        )}
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            <View style={[styles.catBadge, { backgroundColor: catColor + '20' }]}>
              <Text style={[styles.catText, { color: catColor }]}>{job.category}</Text>
            </View>
            {RECUR_LABEL[job.recurrence] && (
              <View style={styles.recurBadge}>
                <Ionicons name="repeat" size={11} color={colors.primary} style={{ marginRight: 3 }} />
                <Text style={styles.recurText}>{RECUR_LABEL[job.recurrence]}</Text>
              </View>
            )}
          </View>
          <Text style={styles.time}>{job.postedAt}</Text>
        </View>
        <Text style={styles.title} numberOfLines={2}>{job.title}</Text>
        <Text style={styles.desc} numberOfLines={2}>{job.description}</Text>
        {job.tags?.length > 0 && (
          <View style={styles.tagRow}>
            {job.tags.slice(0, 4).map(t => (
              <View key={t} style={styles.tagChip}><Text style={styles.tagText}>#{t}</Text></View>
            ))}
          </View>
        )}
        {job.hazards?.length > 0 && (
          <View style={styles.hazardRow}>
            <Ionicons name="warning" size={12} color={colors.urgent} style={{ marginRight: 4 }} />
            <Text style={styles.hazardText}>Safety notes</Text>
          </View>
        )}
        <View style={styles.footer}>
          <View style={styles.payBadge}>
            <Text style={styles.payText}>{estPay}</Text>
          </View>
          <Ionicons name="location" size={13} color={colors.textSecondary} style={{ marginRight: 3 }} />
          <Text style={styles.loc} numberOfLines={1}>
            {job.location}{distanceLabel ? ` · ${distanceLabel}` : ''}
          </Text>
        </View>
        <View style={styles.posterRow}>
          <Avatar url={job.poster.avatarUrl} initial={job.poster.avatarInitial} size={20} fontSize={9} style={{ marginRight: 6 }} />
          <Text style={styles.posterName}>{job.poster.name}</Text>
          {job.poster.verified && <Ionicons name="checkmark-circle" size={13} color={colors.success} style={styles.verified} />}
          {job.poster.studentVerified && <StudentBadge profile={job.poster} compact style={{ marginLeft: 4 }} />}
          <View style={styles.spacer} />
          {job.poster.reviewCount > 0
            ? <RatingStars rating={job.poster.rating} size={12} />
            : <Text style={styles.newBadge}>New</Text>}
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
  cover: { width: '100%', height: 140, borderRadius: 12, marginBottom: 12, backgroundColor: colors.border },
  bookingPill: {
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5,
    alignSelf: 'stretch', marginBottom: 10, alignItems: 'center',
    flexDirection: 'row', justifyContent: 'center',
  },
  bookingPillText: { fontSize: 12, fontWeight: '800' },
  urgentRow: { marginBottom: 8 },
  urgentBadge: {
    backgroundColor: colors.urgentLight, borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start',
    flexDirection: 'row', alignItems: 'center',
  },
  urgentText: { color: colors.urgent, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  recurBadge: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.primary + '14', borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 3, marginLeft: 6,
  },
  recurText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  catBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  catText: { fontSize: 11, fontWeight: '700' },
  time: { fontSize: 11, color: colors.textMuted },
  title: { fontSize: 16, fontWeight: '800', color: colors.textPrimary, marginBottom: 5, lineHeight: 22 },
  desc: { fontSize: 13, color: colors.textSecondary, lineHeight: 19, marginBottom: 12 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  tagChip: { backgroundColor: colors.background, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: colors.border },
  tagText: { fontSize: 11, fontWeight: '600', color: colors.textSecondary },
  hazardRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  hazardText: { fontSize: 11, fontWeight: '700', color: colors.urgent },
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
  newBadge: { fontSize: 11, fontWeight: '700', color: colors.textMuted },
  spacer: { flex: 1 },
});
