import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import GradientHeader from '../components/GradientHeader';
import ChallengeCard from '../components/ChallengeCard';
import JobCard from '../components/JobCard';
import XPBar from '../components/XPBar';
import BookingStatusBadge from '../components/BookingStatusBadge';
import MessageSheet from '../components/MessageSheet';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { useHaptic } from '../hooks/useHaptic';
import { colors, gradients, shadows } from '../theme';

export default function EarnScreen({ navigation }) {
  const {
    earningsToday, earningsWeek, earningsTotal,
    streakDays, levelInfo, xp, challenges,
    weeklyEarningGoal, weeklyJobsGoal, weeklyJobsDone, showToast,
  } = useUser();
  const { bookedJobs, bookings, markJobComplete } = useJobs();
  const haptic = useHaptic();
  const [msgTarget, setMsgTarget] = useState(null);

  const earningPct = Math.min(1, earningsWeek / weeklyEarningGoal);
  const jobsPct    = Math.min(1, weeklyJobsDone / weeklyJobsGoal);

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      <GradientHeader colors={gradients.earn}>
        <Text style={styles.screenTitle}>Hustle Dashboard 💰</Text>
        <LinearGradient colors={['rgba(255,255,255,0.18)', 'rgba(255,255,255,0.08)']} style={styles.earningsCard}>
          <View style={styles.earningsRow}>
            <EarStat label="Today" value={`$${earningsToday}`} />
            <View style={styles.divider} />
            <EarStat label="This Week" value={`$${earningsWeek}`} highlight />
            <View style={styles.divider} />
            <EarStat label="All Time" value={`$${earningsTotal.toLocaleString()}`} />
          </View>
        </LinearGradient>
        <View style={styles.streakLevelRow}>
          <View style={styles.streakPill}>
            <Text style={styles.streakFire}>🔥</Text>
            <Text style={styles.streakText}>{streakDays}-day streak</Text>
          </View>
          <View style={styles.xpWrap}>
            <XPBar levelInfo={levelInfo} xp={xp} dark />
          </View>
        </View>
      </GradientHeader>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Weekly Goals</Text>
        <View style={[styles.card, { padding: 16 }]}>
          <GoalBar label="Earnings" value={`$${earningsWeek}`} max={`$${weeklyEarningGoal}`} pct={earningPct} color={colors.accent} />
          <View style={{ height: 14 }} />
          <GoalBar label="Jobs Done" value={`${weeklyJobsDone}`} max={`${weeklyJobsGoal} gigs`} pct={jobsPct} color={colors.primary} />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Active Challenges</Text>
        {challenges.map(c => <ChallengeCard key={c.id} challenge={c} />)}
      </View>

      {bookedJobs.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Your Booked Gigs</Text>
          {bookedJobs.map(j => {
            const booking = bookings.find(b => b.jobId === j.id);
            const status  = booking?.status || 'pending';
            return (
              <View key={j.id} style={styles.bookedItem}>
                <JobCard job={j} onPress={() => navigation.navigate('JobDetail', { jobId: j.id })} />

                <View style={styles.bookingMeta}>
                  {/* Status badge */}
                  <BookingStatusBadge status={status} />

                  {/* Slot + counter-offer info */}
                  {booking?.slotLabel && (
                    <View style={styles.bookingRow}>
                      <Text style={styles.bookingIcon}>📅</Text>
                      <Text style={styles.bookingText}>{booking.slotLabel}</Text>
                    </View>
                  )}
                  {booking?.counterOffer && (
                    <View style={styles.bookingRow}>
                      <Text style={styles.bookingIcon}>💬</Text>
                      <Text style={styles.bookingText}>
                        Counter-offer: <Text style={styles.bookingBold}>
                          ${booking.counterOffer}{j.payType === 'hourly' ? '/hr' : ' flat'}
                        </Text>
                      </Text>
                    </View>
                  )}

                  {/* Verified result */}
                  {status === 'verified' && booking?.earnerRating && (
                    <View style={styles.verifiedRow}>
                      <Text style={styles.verifiedText}>
                        {'⭐'.repeat(Math.round(booking.earnerRating))} {Number(booking.earnerRating).toFixed(1)} stars
                        {booking.paymentMethod ? ` · Paid via ${booking.paymentMethod}` : ''}
                      </Text>
                      {booking.reviewText ? (
                        <Text style={styles.reviewQuote}>"{booking.reviewText}"</Text>
                      ) : null}
                    </View>
                  )}

                  {/* Mark Complete button (only when confirmed) */}
                  {status === 'confirmed' && (
                    <TouchableOpacity
                      style={styles.completeBtn}
                      onPress={() => {
                        haptic.success();
                        markJobComplete(booking.id);
                        showToast({ icon: '🔄', title: 'Marked Complete!', message: 'Waiting for the poster to verify and rate you.' });
                      }}
                    >
                      <Text style={styles.completeBtnText}>✓ I Completed This Job</Text>
                    </TouchableOpacity>
                  )}

                  {/* Message Poster button */}
                  {(status === 'pending' || status === 'confirmed') && (
                    <TouchableOpacity
                      style={styles.msgBtn}
                      onPress={() => setMsgTarget({
                        bookingId: booking.id,
                        jobTitle: j.title,
                        otherPerson: { name: j.poster?.name || 'Poster', avatarInitial: j.poster?.avatarInitial || 'P' },
                      })}
                    >
                      <Text style={styles.msgBtnText}>💬 Message Poster</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      )}

      <MessageSheet
        visible={!!msgTarget}
        bookingId={msgTarget?.bookingId}
        jobTitle={msgTarget?.jobTitle}
        otherPerson={msgTarget?.otherPerson}
        onClose={() => setMsgTarget(null)}
      />

      {bookedJobs.length === 0 && (
        <View style={styles.emptyGigs}>
          <Text style={styles.emptyIcon}>📋</Text>
          <Text style={styles.emptyTitle}>No booked gigs yet</Text>
          <Text style={styles.emptyText}>Browse the Home tab and book your first gig to start earning!</Text>
        </View>
      )}
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}

function EarStat({ label, value, highlight }) {
  return (
    <View style={styles.earStat}>
      <Text style={[styles.earValue, highlight && styles.earValueHL]}>{value}</Text>
      <Text style={styles.earLabel}>{label}</Text>
    </View>
  );
}

function GoalBar({ label, value, max, pct, color }) {
  return (
    <View>
      <View style={styles.goalHeader}>
        <Text style={styles.goalLabel}>{label}</Text>
        <Text style={[styles.goalValue, { color }]}>{value} / {max}</Text>
      </View>
      <View style={styles.goalTrack}>
        <View style={[styles.goalFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  screenTitle: { fontSize: 22, fontWeight: '800', color: '#fff', marginBottom: 16 },
  earningsCard: { borderRadius: 18, padding: 20, marginBottom: 16 },
  earningsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  earStat: { alignItems: 'center', flex: 1 },
  earValue: { fontSize: 20, fontWeight: '800', color: '#fff', marginBottom: 2 },
  earValueHL: { fontSize: 26 },
  earLabel: { fontSize: 11, color: 'rgba(255,255,255,0.7)', fontWeight: '600' },
  divider: { width: 1, height: 40, backgroundColor: 'rgba(255,255,255,0.2)' },
  streakLevelRow: { flexDirection: 'row', alignItems: 'center' },
  streakPill: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7,
    marginRight: 12,
  },
  streakFire: { fontSize: 16, marginRight: 5 },
  streakText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  xpWrap: { flex: 1 },
  section: { paddingHorizontal: 16, marginTop: 24 },
  sectionTitle: {
    fontSize: 13, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 12,
  },
  card: {
    backgroundColor: colors.surface, borderRadius: 18,
    borderWidth: 1, borderColor: colors.border,
    ...shadows.sm,
  },
  goalHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  goalLabel: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  goalValue: { fontSize: 13, fontWeight: '700' },
  goalTrack: { height: 10, borderRadius: 5, backgroundColor: colors.divider, overflow: 'hidden' },
  goalFill: { height: 10, borderRadius: 5 },
  bookedItem: { marginBottom: 4 },
  bookingMeta: {
    backgroundColor: colors.surface, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 12,
    marginTop: -4, marginBottom: 12,
    borderWidth: 1, borderColor: colors.border,
    borderTopLeftRadius: 0, borderTopRightRadius: 0,
  },
  bookingRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 8 },
  bookingIcon: { fontSize: 12, marginRight: 6, marginTop: 1 },
  bookingText: { fontSize: 12, color: colors.textSecondary, flex: 1, lineHeight: 18 },
  bookingBold: { fontWeight: '800', color: colors.primary },
  verifiedRow: {
    backgroundColor: colors.accentLight, borderRadius: 10,
    padding: 10, marginTop: 8,
  },
  verifiedText: { fontSize: 13, fontWeight: '700', color: colors.success },
  reviewQuote: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', marginTop: 3 },
  completeBtn: {
    backgroundColor: colors.primaryLight, borderRadius: 12,
    paddingVertical: 12, alignItems: 'center', marginTop: 12,
    borderWidth: 1.5, borderColor: colors.primary,
  },
  completeBtnText: { fontSize: 14, fontWeight: '800', color: colors.primary },
  msgBtn: {
    borderRadius: 12, paddingVertical: 10, alignItems: 'center', marginTop: 8,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface,
  },
  msgBtnText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  emptyGigs: { alignItems: 'center', padding: 40 },
  emptyIcon: { fontSize: 44, marginBottom: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary, marginBottom: 8 },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
});
