import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, shadows } from '../theme';
import { useJobs } from '../context/JobsContext';
import { useHaptic } from '../hooks/useHaptic';
import { maskLocation, canSeeExactAddress } from '../lib/address';
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

// attached: renders with a square bottom edge so a status panel can sit flush
// beneath it and the pair reads as ONE card (rounded top, rounded bottom).
export default function JobCard({ job, onPress, bookingStatus, distanceLabel, attached }) {
  const haptic = useHaptic();
  const { savedJobIds, toggleSavedJob } = useJobs();
  const saved = savedJobIds.has(job.id);
  const estPay = job.payType === 'hourly'
    ? `$${job.pay * (job.estimatedHours || 1)}–${job.pay * (job.estimatedHours || 1) + job.pay} est.`
    : `$${job.pay} flat`;
  const meta = RECUR_LABEL[job.recurrence]
    ? `${job.category} · ${RECUR_LABEL[job.recurrence]}`
    : job.category;

  return (
    <TouchableOpacity
      style={[styles.card, attached && styles.cardAttached]}
      onPress={() => { haptic.light(); onPress(); }}
      activeOpacity={0.82}
    >
      <TouchableOpacity
        style={styles.saveBtn}
        onPress={() => { haptic.light(); toggleSavedJob(job.id); }}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityLabel={saved ? 'Unsave gig' : 'Save gig'}
      >
        <Ionicons name={saved ? 'bookmark' : 'bookmark-outline'} size={16} color={saved ? colors.primary : colors.textMuted} />
      </TouchableOpacity>
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
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            {job.urgent && (
              <View style={styles.urgentBadge}>
                <Ionicons name="flash" size={10} color={colors.urgent} style={{ marginRight: 3 }} />
                <Text style={styles.urgentText}>Urgent</Text>
              </View>
            )}
            <Text style={styles.metaText} numberOfLines={1}>{meta}</Text>
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
          <Text style={styles.payText}>{estPay}</Text>
          <View style={styles.locWrap}>
            <Ionicons name="location-outline" size={12} color={colors.textMuted} style={{ marginRight: 3 }} />
            <Text style={styles.loc} numberOfLines={1}>
              {canSeeExactAddress({ bookingStatus }) ? job.location : maskLocation(job.location)}
              {distanceLabel ? ` · ${distanceLabel}` : ''}
            </Text>
          </View>
        </View>
        <View style={styles.posterRow}>
          <Avatar url={job.poster.avatarUrl} initial={job.poster.avatarInitial} size={20} fontSize={9} style={{ marginRight: 6 }} />
          <Text style={styles.posterName} numberOfLines={1}>{job.poster.name}</Text>
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
    marginBottom: 12,
    overflow: 'hidden',
    ...shadows.card,
  },
  cardAttached: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    marginBottom: 0,
  },
  saveBtn: {
    position: 'absolute', top: 12, right: 12, zIndex: 2,
    backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 16, padding: 6,
  },
  body: { padding: 16 },
  cover: { width: '100%', height: 140, borderRadius: 14, marginBottom: 12, backgroundColor: colors.divider },
  bookingPill: {
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5,
    alignSelf: 'stretch', marginBottom: 10, alignItems: 'center',
    flexDirection: 'row', justifyContent: 'center',
    // Clear the absolute bookmark button in the top-right so they don't overlap
    // when the pill is the card's top element (matches headerRow's paddingRight).
    marginRight: 30,
  },
  bookingPillText: { fontSize: 12, fontWeight: '700' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingRight: 28 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  urgentBadge: {
    backgroundColor: colors.urgentLight, borderRadius: 999,
    paddingHorizontal: 8, paddingVertical: 3, marginRight: 8,
    flexDirection: 'row', alignItems: 'center',
  },
  urgentText: { color: colors.urgent, fontSize: 11, fontWeight: '700' },
  metaText: { fontSize: 12, fontWeight: '500', color: colors.textMuted, flexShrink: 1 },
  time: { fontSize: 12, color: colors.textMuted },
  title: { fontSize: 17, fontWeight: '700', color: colors.textPrimary, marginBottom: 4, lineHeight: 22, letterSpacing: -0.2 },
  desc: { fontSize: 13.5, color: colors.textSecondary, lineHeight: 19, marginBottom: 12 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  tagChip: { backgroundColor: colors.background, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  tagText: { fontSize: 11, fontWeight: '500', color: colors.textSecondary },
  hazardRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  hazardText: { fontSize: 11, fontWeight: '700', color: colors.urgent },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  payText: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  locWrap: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, marginLeft: 10 },
  loc: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  posterRow: { flexDirection: 'row', alignItems: 'center', paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.divider },
  // Must shrink, or a long poster name evicts the rating stars past the card's
  // overflow:'hidden' edge and they vanish.
  posterName: { fontSize: 12, fontWeight: '600', color: colors.textSecondary, marginRight: 4, flexShrink: 1, minWidth: 0 },
  verified: { fontSize: 11, color: colors.success },
  newBadge: { fontSize: 11, fontWeight: '600', color: colors.textMuted },
  spacer: { flex: 1 },
});
