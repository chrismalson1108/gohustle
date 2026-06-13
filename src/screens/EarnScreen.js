import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  Modal, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
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

const ACTIVE_STATUSES = new Set(['pending', 'confirmed', 'completed']);

export default function EarnScreen({ navigation }) {
  const {
    earningsToday, earningsWeek, earningsTotal,
    streakDays, levelInfo, xp, challenges,
    weeklyEarningGoal, weeklyJobsGoal, weeklyJobsDone, showToast,
  } = useUser();
  const { bookedJobs, bookings, markEarnerDone, ratePoster, respondToAmendment, refreshBookings, refreshJobs, getPayoutStatus } = useJobs();
  const haptic = useHaptic();
  const [msgTarget, setMsgTarget]       = useState(null);
  const [rateTarget, setRateTarget]     = useState(null);
  const [posterRating, setPosterRating] = useState(5);
  const [posterReview, setPosterReview] = useState('');
  const [ratingLoading, setRatingLoading] = useState(false);
  const [refreshing, setRefreshing]     = useState(false);
  const [payoutReady, setPayoutReady]   = useState(true); // optimistic until checked

  useEffect(() => {
    getPayoutStatus().then(s => setPayoutReady(s.onboarded));
  }, []);

  // Refresh from DB every time this tab gains focus
  useFocusEffect(
    useCallback(() => {
      refreshBookings();
      refreshJobs();
    }, [])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshBookings(), refreshJobs()]);
    setRefreshing(false);
  };

  const earningPct = Math.min(1, earningsWeek / weeklyEarningGoal);
  const jobsPct    = Math.min(1, weeklyJobsDone / weeklyJobsGoal);

  const handleMarkDone = (booking) => {
    haptic.success();
    markEarnerDone(booking.id);
    if (booking.posterDone) {
      showToast({ icon: '🎉', title: 'Job Complete!', message: 'Both parties confirmed. Waiting for the poster to verify and rate you.' });
    } else {
      showToast({ icon: '✅', title: 'Marked Done!', message: "We've notified the poster. Waiting for them to confirm." });
    }
  };

  const handleRatePoster = async () => {
    if (!rateTarget) return;
    setRatingLoading(true);
    haptic.success();
    await ratePoster(rateTarget.id, { rating: posterRating, reviewText: posterReview });
    setRatingLoading(false);
    setRateTarget(null);
    setPosterRating(5);
    setPosterReview('');
    showToast({ icon: '⭐', title: 'Rating Submitted!', message: 'Thanks for rating the poster.' });
  };

  return (
    <ScrollView
      style={styles.container}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <GradientHeader colors={gradients.earn}>
        <Text style={styles.screenTitle}>Hustle Dashboard 💰</Text>
        <LinearGradient colors={['rgba(255,255,255,0.18)', 'rgba(255,255,255,0.08)']} style={styles.earningsCard}>
          <View style={styles.earningsRow}>
            <EarStat label="Today"     value={`$${earningsToday}`} />
            <View style={styles.divider} />
            <EarStat label="This Week" value={`$${earningsWeek}`} highlight />
            <View style={styles.divider} />
            <EarStat label="All Time"  value={`$${earningsTotal.toLocaleString()}`} />
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

      {/* Payout setup banner — shown until earner connects bank */}
      {!payoutReady && (
        <TouchableOpacity
          style={styles.payoutBanner}
          onPress={() => navigation.navigate('ProfileTab', { screen: 'PayoutSetup' })}
          activeOpacity={0.85}
        >
          <Ionicons name="wallet-outline" size={20} color="#fff" />
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={styles.payoutBannerTitle}>Set up payouts to get paid</Text>
            <Text style={styles.payoutBannerSub}>Connect your bank account via Stripe →</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.7)" />
        </TouchableOpacity>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Your Gigs</Text>
        {bookedJobs.length === 0 && (
          <View style={styles.noGigsCard}>
            <Text style={styles.emptyIcon}>📋</Text>
            <Text style={styles.emptyTitle}>No booked gigs yet</Text>
            <Text style={styles.emptyText}>Browse the Home tab and book your first gig to start earning!</Text>
          </View>
        )}
          {bookedJobs.map(j => {
            const booking = bookings.find(b => b.jobId === j.id);
            if (!booking) return null;
            const status = booking.status;
            return (
              <View key={j.id} style={styles.bookedItem}>
                <JobCard job={j} onPress={() => navigation.navigate('JobDetail', { jobId: j.id })} />

                <View style={styles.bookingMeta}>
                  <BookingStatusBadge status={status} />

                  {booking.slotLabel && (
                    <View style={styles.bookingRow}>
                      <Text style={styles.bookingIcon}>📅</Text>
                      <Text style={styles.bookingText}>{booking.slotLabel}</Text>
                    </View>
                  )}
                  {booking.counterOffer && (
                    <View style={styles.bookingRow}>
                      <Text style={styles.bookingIcon}>💬</Text>
                      <Text style={styles.bookingText}>
                        Counter-offer: <Text style={styles.bookingBold}>
                          ${booking.counterOffer}{j.payType === 'hourly' ? '/hr' : ' flat'}
                        </Text>
                      </Text>
                    </View>
                  )}

                  {/* Amendment notifications */}
                  {booking.amendmentStatus === 'pending' && (
                    <View style={styles.amendCard}>
                      <Text style={styles.amendCardTitle}>📝 Change Proposed by Poster</Text>
                      <Text style={styles.amendCardNote}>{booking.amendmentNote}</Text>
                      <View style={styles.amendCardActions}>
                        <TouchableOpacity style={styles.amendAcceptBtn}
                          onPress={() => {
                            respondToAmendment(booking.id, true);
                            showToast({ icon: '✅', title: 'Amendment Accepted', message: 'The poster can now update the gig terms.' });
                          }}>
                          <Text style={styles.amendAcceptText}>✓ Accept</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.amendDeclineBtn}
                          onPress={() => {
                            respondToAmendment(booking.id, false);
                            showToast({ icon: '❌', title: 'Amendment Declined', message: 'Original terms remain in effect.' });
                          }}>
                          <Text style={styles.amendDeclineText}>✕ Decline</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}
                  {booking.amendmentStatus === 'accepted' && (
                    <View style={styles.amendStatusBanner}>
                      <Text style={styles.amendStatusText}>✅ Change accepted — poster is updating the terms</Text>
                    </View>
                  )}
                  {booking.amendmentStatus === 'declined' && (
                    <View style={[styles.amendStatusBanner, { backgroundColor: '#FEF2F2' }]}>
                      <Text style={[styles.amendStatusText, { color: '#DC2626' }]}>❌ Change declined — original terms apply</Text>
                    </View>
                  )}

                  {/* In-progress banner */}
                  {status === 'confirmed' && (
                    <View style={styles.inProgressBanner}>
                      <Text style={styles.inProgressText}>🟢 In Progress</Text>
                    </View>
                  )}

                  {/* Waiting indicators */}
                  {status === 'confirmed' && booking.earnerDone && !booking.posterDone && (
                    <View style={styles.waitingBanner}>
                      <Text style={styles.waitingText}>⏳ Waiting for poster to confirm done…</Text>
                    </View>
                  )}

                  {/* Mark Done — show when confirmed and earner hasn't marked yet */}
                  {status === 'confirmed' && !booking.earnerDone && (
                    <TouchableOpacity
                      style={styles.completeBtn}
                      onPress={() => handleMarkDone(booking)}
                    >
                      <Text style={styles.completeBtnText}>✓ I Finished This Job</Text>
                    </TouchableOpacity>
                  )}

                  {/* Verified result — poster rated earner */}
                  {status === 'verified' && booking.earnerRating && (
                    <View style={styles.verifiedRow}>
                      <Text style={styles.verifiedText}>
                        {'⭐'.repeat(Math.round(booking.earnerRating))} {Number(booking.earnerRating).toFixed(1)} stars from poster
                        {booking.paymentMethod ? ` · Paid via ${booking.paymentMethod}` : ''}
                      </Text>
                      {booking.reviewText ? (
                        <Text style={styles.reviewQuote}>"{booking.reviewText}"</Text>
                      ) : null}
                    </View>
                  )}

                  {/* Rate the poster — show after verified if not yet rated */}
                  {status === 'verified' && !booking.posterRating && (
                    <TouchableOpacity
                      style={styles.ratePosterBtn}
                      onPress={() => { setPosterRating(5); setPosterReview(''); setRateTarget(booking); }}
                    >
                      <Text style={styles.ratePosterBtnText}>⭐ Rate the Poster</Text>
                    </TouchableOpacity>
                  )}
                  {status === 'verified' && booking.posterRating && (
                    <Text style={styles.posterRatedText}>
                      You rated the poster {booking.posterRating} ⭐
                    </Text>
                  )}

                  {/* Message button — all active statuses */}
                  {ACTIVE_STATUSES.has(status) && (
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

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Weekly Goals</Text>
        <View style={[styles.card, { padding: 16 }]}>
          <GoalBar label="Earnings"  value={`$${earningsWeek}`}  max={`$${weeklyEarningGoal}`} pct={earningPct} color={colors.accent} />
          <View style={{ height: 14 }} />
          <GoalBar label="Jobs Done" value={`${weeklyJobsDone}`} max={`${weeklyJobsGoal} gigs`} pct={jobsPct} color={colors.primary} />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Active Challenges</Text>
        {challenges.map(c => <ChallengeCard key={c.id} challenge={c} />)}
      </View>

      <View style={{ height: 30 }} />

      <MessageSheet
        visible={!!msgTarget}
        bookingId={msgTarget?.bookingId}
        jobTitle={msgTarget?.jobTitle}
        otherPerson={msgTarget?.otherPerson}
        onClose={() => setMsgTarget(null)}
      />

      {/* Rate Poster Modal */}
      <Modal visible={!!rateTarget} animationType="slide" transparent onRequestClose={() => setRateTarget(null)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setRateTarget(null)} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Rate the Poster</Text>
            <Text style={styles.modalSub}>
              How was {rateTarget?.job?.title || 'this gig'} as an employer?
            </Text>

            {/* Stars */}
            <View style={styles.starRow}>
              {[1,2,3,4,5].map(s => (
                <TouchableOpacity key={s} onPress={() => { haptic.selection(); setPosterRating(s); }}>
                  <Text style={styles.star}>{s <= posterRating ? '⭐' : '☆'}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.ratingLabel}>
              {posterRating === 5 ? 'Excellent employer!' : posterRating === 4 ? 'Great experience' : posterRating === 3 ? 'It was okay' : posterRating === 2 ? 'Some issues' : 'Poor experience'}
            </Text>

            <TextInput
              style={styles.reviewInput}
              placeholder="Leave a comment (optional)…"
              placeholderTextColor={colors.textMuted}
              value={posterReview}
              onChangeText={setPosterReview}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
              maxLength={280}
            />

            <TouchableOpacity onPress={handleRatePoster} disabled={ratingLoading} activeOpacity={0.85}>
              <LinearGradient colors={gradients.earn} style={styles.submitBtn}>
                {ratingLoading
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.submitBtnText}>Submit Rating</Text>
                }
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setRateTarget(null)} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  payoutBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#7C3AED',
    marginHorizontal: 16, marginTop: 12,
    borderRadius: 14, padding: 14,
  },
  payoutBannerTitle: { color: '#fff', fontSize: 13, fontWeight: '700' },
  payoutBannerSub: { color: 'rgba(255,255,255,0.75)', fontSize: 12, marginTop: 1 },
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
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, marginRight: 12,
  },
  streakFire: { fontSize: 16, marginRight: 5 },
  streakText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  xpWrap: { flex: 1 },
  section: { paddingHorizontal: 16, marginTop: 24 },
  sectionTitle: {
    fontSize: 13, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 12,
  },
  card: { backgroundColor: colors.surface, borderRadius: 18, borderWidth: 1, borderColor: colors.border, ...shadows.sm },
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
  inProgressBanner: {
    backgroundColor: '#ECFDF5', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6, marginTop: 8, alignSelf: 'flex-start',
  },
  inProgressText: { fontSize: 12, fontWeight: '700', color: colors.success },
  amendCard: {
    backgroundColor: '#FFFBEB', borderRadius: 12, padding: 12, marginTop: 10,
    borderWidth: 1.5, borderColor: '#FCD34D',
  },
  amendCardTitle: { fontSize: 13, fontWeight: '800', color: '#D97706', marginBottom: 6 },
  amendCardNote: { fontSize: 13, color: colors.textPrimary, lineHeight: 19, marginBottom: 10 },
  amendCardActions: { flexDirection: 'row', gap: 10 },
  amendAcceptBtn: {
    flex: 1, backgroundColor: colors.success, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center',
  },
  amendAcceptText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  amendDeclineBtn: {
    flex: 1, backgroundColor: colors.surface, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center',
    borderWidth: 1.5, borderColor: colors.border,
  },
  amendDeclineText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  amendStatusBanner: {
    backgroundColor: '#ECFDF5', borderRadius: 8, padding: 9, marginTop: 8,
  },
  amendStatusText: { fontSize: 12, fontWeight: '600', color: '#059669' },
  waitingBanner: {
    backgroundColor: '#FFF7ED', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6, marginTop: 8,
  },
  waitingText: { fontSize: 12, fontWeight: '600', color: '#D97706' },
  completeBtn: {
    backgroundColor: colors.primaryLight, borderRadius: 12,
    paddingVertical: 12, alignItems: 'center', marginTop: 12,
    borderWidth: 1.5, borderColor: colors.primary,
  },
  completeBtnText: { fontSize: 14, fontWeight: '800', color: colors.primary },
  verifiedRow: {
    backgroundColor: colors.accentLight, borderRadius: 10,
    padding: 10, marginTop: 8,
  },
  verifiedText: { fontSize: 13, fontWeight: '700', color: colors.success },
  reviewQuote: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', marginTop: 3 },
  ratePosterBtn: {
    borderRadius: 12, paddingVertical: 10, alignItems: 'center', marginTop: 8,
    borderWidth: 1.5, borderColor: colors.gold, backgroundColor: '#FFFBEB',
  },
  ratePosterBtnText: { fontSize: 13, fontWeight: '700', color: '#D97706' },
  posterRatedText: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', marginTop: 8, textAlign: 'center' },
  msgBtn: {
    borderRadius: 12, paddingVertical: 10, alignItems: 'center', marginTop: 8,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface,
  },
  msgBtnText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  emptyGigs: { alignItems: 'center', padding: 40 },
  noGigsCard: {
    backgroundColor: colors.surface, borderRadius: 14, padding: 24,
    alignItems: 'center', borderWidth: 1, borderColor: colors.border,
  },
  emptyIcon: { fontSize: 44, marginBottom: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary, marginBottom: 8 },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  // Rate poster modal
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  modalSheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 24, paddingBottom: 40, ...shadows.md,
  },
  modalHandle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border,
    alignSelf: 'center', marginTop: 12, marginBottom: 20,
  },
  modalTitle: { fontSize: 22, fontWeight: '900', color: colors.textPrimary, marginBottom: 6 },
  modalSub: { fontSize: 14, color: colors.textSecondary, marginBottom: 20 },
  starRow: { flexDirection: 'row', marginBottom: 8 },
  star: { fontSize: 34, marginRight: 4, color: colors.border },
  ratingLabel: { fontSize: 13, color: colors.textMuted, fontStyle: 'italic', marginBottom: 16 },
  reviewInput: {
    backgroundColor: colors.background, borderRadius: 14,
    borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 14, color: colors.textPrimary, minHeight: 80, marginBottom: 20,
  },
  submitBtn: { borderRadius: 16, paddingVertical: 17, alignItems: 'center' },
  submitBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  cancelBtn: { paddingVertical: 14, alignItems: 'center' },
  cancelText: { fontSize: 14, color: colors.textMuted, fontWeight: '600' },
});
