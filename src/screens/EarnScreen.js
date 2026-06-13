import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, Image,
  Modal, TextInput, KeyboardAvoidingView, Platform, ActivityIndicator,
  RefreshControl, Alert,
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
import { useAuth } from '../context/AuthContext';
import { useHaptic } from '../hooks/useHaptic';
import { pickImages, uploadImages } from '../lib/uploadImage';
import { colors, gradients, shadows } from '../theme';

const ACTIVE_STATUSES    = new Set(['confirmed', 'completed']); // in progress / needs action
const AWAITING_STATUSES  = new Set(['pending']);                // waiting on poster
const COMPLETED_STATUSES = new Set(['verified', 'declined', 'cancelled']); // finished / closed
const ONGOING_STATUSES   = new Set(['pending', 'confirmed', 'completed']); // can still message

export default function EarnScreen({ navigation }) {
  const {
    earningsToday, earningsWeek, earningsTotal,
    streakDays, levelInfo, xp, challenges,
    weeklyEarningGoal, weeklyJobsGoal, weeklyJobsDone, showToast,
  } = useUser();
  const { bookedJobs, bookings, markEarnerDone, ratePoster, respondToAmendment, cancelBooking, refreshBookings, refreshJobs, getPayoutStatus } = useJobs();
  const { user } = useAuth();
  const haptic = useHaptic();
  const [tab, setTab]                   = useState('active'); // 'active' | 'awaiting' | 'completed'
  const [msgTarget, setMsgTarget]       = useState(null);
  const [finishTarget, setFinishTarget] = useState(null); // booking being marked done
  const [finishPhotos, setFinishPhotos] = useState([]);   // local URIs to upload
  const [finishing, setFinishing]       = useState(false);
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

  // Pair each booked job with its booking, then split by segment
  const pairs = bookedJobs
    .map(j => ({ job: j, booking: bookings.find(b => b.jobId === j.id) }))
    .filter(p => p.booking);
  const activePairs    = pairs.filter(p => ACTIVE_STATUSES.has(p.booking.status));
  const awaitingPairs  = pairs.filter(p => AWAITING_STATUSES.has(p.booking.status));
  const completedPairs = pairs.filter(p => COMPLETED_STATUSES.has(p.booking.status));
  const shownPairs     = tab === 'active' ? activePairs : tab === 'awaiting' ? awaitingPairs : completedPairs;

  // Open the finish sheet (lets the earner optionally attach proof photos)
  const handleMarkDone = (booking) => {
    setFinishPhotos([]);
    setFinishTarget(booking);
  };

  const handleAddFinishPhotos = async () => {
    const res = await pickImages({ multiple: true });
    if (res.canceled) {
      if (res.denied) showToast({ icon: '⚠️', title: 'Photos access needed', message: 'Allow photo access in Settings to attach photos.' });
      return;
    }
    setFinishPhotos(prev => [...prev, ...res.uris].slice(0, 6));
  };

  const handleConfirmFinish = async () => {
    if (!finishTarget) return;
    setFinishing(true);
    try {
      let urls = null;
      if (finishPhotos.length) {
        urls = await uploadImages({ uris: finishPhotos, bucket: 'completion-photos', userId: user.id });
      }
      await markEarnerDone(finishTarget.id, urls);
      haptic.success();
      if (finishTarget.posterDone) {
        showToast({ icon: '🎉', title: 'Job Complete!', message: 'Both parties confirmed. Waiting for the poster to verify and rate you.' });
      } else {
        showToast({ icon: '✅', title: 'Marked Done!', message: "We've notified the poster. Waiting for them to confirm." });
      }
      setFinishTarget(null);
      setFinishPhotos([]);
    } catch (e) {
      showToast({ icon: '⚠️', title: 'Could not finish', message: e.message || 'Please try again.' });
    }
    setFinishing(false);
  };

  const handleCancel = (booking) => {
    const isPending = booking.status === 'pending';
    Alert.alert(
      isPending ? 'Withdraw application?' : 'Cancel booking?',
      isPending
        ? 'This removes your request for this gig.'
        : 'This cancels the confirmed gig and releases any payment hold.',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: isPending ? 'Withdraw' : 'Cancel gig', style: 'destructive',
          onPress: () => {
            haptic.medium();
            cancelBooking(booking.id);
            showToast({ icon: '❌', title: isPending ? 'Withdrawn' : 'Booking cancelled', message: isPending ? 'Your request was removed.' : 'The gig was cancelled.' });
          },
        },
      ]
    );
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
        <View style={styles.titleRow}>
          <Ionicons name="briefcase" size={22} color="#fff" style={{ marginRight: 8 }} />
          <Text style={styles.screenTitle}>My Jobs</Text>
        </View>
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
            <Ionicons name="flame" size={15} color="#FB923C" style={{ marginRight: 5 }} />
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
          onPress={() => navigation.navigate('ProfileTab', { screen: 'PayoutSetup', initial: false })}
          activeOpacity={0.85}
        >
          <Ionicons name="wallet-outline" size={20} color="#fff" />
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={styles.payoutBannerTitle}>Set up payouts to get paid</Text>
            <Text style={styles.payoutBannerSub}>Connect your bank to receive earnings →</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.7)" />
        </TouchableOpacity>
      )}

      {/* Segmented control for my gigs */}
      <View style={styles.segment}>
        <SegmentBtn label="Active"    count={activePairs.length}    active={tab === 'active'}    onPress={() => { haptic.selection(); setTab('active'); }} />
        <SegmentBtn label="Awaiting"  count={awaitingPairs.length}  active={tab === 'awaiting'}  onPress={() => { haptic.selection(); setTab('awaiting'); }} />
        <SegmentBtn label="Completed" count={completedPairs.length} active={tab === 'completed'} onPress={() => { haptic.selection(); setTab('completed'); }} />
      </View>

      <View style={styles.section}>
        {shownPairs.length === 0 && (
          <View style={styles.noGigsCard}>
            <Ionicons
              name={tab === 'active' ? 'briefcase-outline' : tab === 'awaiting' ? 'hourglass-outline' : 'checkmark-done-circle-outline'}
              size={42} color={colors.textMuted} style={{ marginBottom: 12 }}
            />
            <Text style={styles.emptyTitle}>
              {tab === 'active' ? 'No active jobs' : tab === 'awaiting' ? 'Nothing awaiting' : 'No completed jobs yet'}
            </Text>
            <Text style={styles.emptyText}>
              {tab === 'active'
                ? 'Jobs you’re actively working show up here. Browse the Home tab to book one!'
                : tab === 'awaiting'
                  ? 'Gigs you’ve applied to — waiting on the poster to accept — appear here.'
                  : 'Completed and declined gigs will show up here.'}
            </Text>
          </View>
        )}

        {shownPairs.map(({ job: j, booking }) => {
          const status = booking.status;
          return (
            <View key={j.id} style={styles.bookedItem}>
              <JobCard job={j} bookingStatus={status} onPress={() => navigation.navigate('JobDetail', { jobId: j.id })} />

              <View style={styles.bookingMeta}>
                <BookingStatusBadge status={status} />

                {booking.slotLabel && (
                  <View style={styles.bookingRow}>
                    <Ionicons name="calendar-outline" size={13} color={colors.textMuted} style={styles.bookingIcon} />
                    <Text style={styles.bookingText}>{booking.slotLabel}</Text>
                  </View>
                )}
                {booking.counterOffer && (
                  <View style={styles.bookingRow}>
                    <Ionicons name="chatbubble-outline" size={13} color={colors.textMuted} style={styles.bookingIcon} />
                    <Text style={styles.bookingText}>
                      Counter-offer: <Text style={styles.bookingBold}>
                        ${booking.counterOffer}{j.payType === 'hourly' ? '/hr' : ' flat'}
                      </Text>
                    </Text>
                  </View>
                )}

                {/* Completion photos you submitted */}
                {booking.completionPhotos?.length > 0 && (
                  <View style={styles.photoStrip}>
                    <Text style={styles.photoStripLabel}>Your completion photos</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      {booking.completionPhotos.map((u, i) => (
                        <Image key={i} source={{ uri: u }} style={styles.photoThumb} />
                      ))}
                    </ScrollView>
                  </View>
                )}

                {/* Amendment notifications */}
                {booking.amendmentStatus === 'pending' && (
                  <View style={styles.amendCard}>
                    <View style={styles.amendCardTitleRow}>
                      <Ionicons name="document-text-outline" size={14} color="#D97706" style={{ marginRight: 6 }} />
                      <Text style={styles.amendCardTitle}>Change Proposed by Poster</Text>
                    </View>
                    <Text style={styles.amendCardNote}>{booking.amendmentNote}</Text>
                    <View style={styles.amendCardActions}>
                      <TouchableOpacity style={styles.amendAcceptBtn}
                        onPress={() => {
                          respondToAmendment(booking.id, true);
                          showToast({ icon: '✅', title: 'Amendment Accepted', message: 'The poster can now update the gig terms.' });
                        }}>
                        <Ionicons name="checkmark" size={15} color="#fff" style={{ marginRight: 4 }} />
                        <Text style={styles.amendAcceptText}>Accept</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.amendDeclineBtn}
                        onPress={() => {
                          respondToAmendment(booking.id, false);
                          showToast({ icon: '❌', title: 'Amendment Declined', message: 'Original terms remain in effect.' });
                        }}>
                        <Ionicons name="close" size={15} color={colors.textSecondary} style={{ marginRight: 4 }} />
                        <Text style={styles.amendDeclineText}>Decline</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
                {booking.amendmentStatus === 'accepted' && (
                  <View style={styles.amendStatusBanner}>
                    <Text style={styles.amendStatusText}>Change accepted — poster is updating the terms</Text>
                  </View>
                )}
                {booking.amendmentStatus === 'declined' && (
                  <View style={[styles.amendStatusBanner, { backgroundColor: '#FEF2F2' }]}>
                    <Text style={[styles.amendStatusText, { color: '#DC2626' }]}>Change declined — original terms apply</Text>
                  </View>
                )}

                {/* In-progress banner */}
                {status === 'confirmed' && (
                  <View style={styles.inProgressBanner}>
                    <Ionicons name="ellipse" size={9} color={colors.success} style={{ marginRight: 5 }} />
                    <Text style={styles.inProgressText}>In Progress</Text>
                  </View>
                )}

                {/* Waiting indicators */}
                {status === 'confirmed' && booking.earnerDone && !booking.posterDone && (
                  <View style={styles.waitingBanner}>
                    <Ionicons name="hourglass-outline" size={13} color="#D97706" style={{ marginRight: 5 }} />
                    <Text style={styles.waitingText}>Waiting for poster to confirm done…</Text>
                  </View>
                )}

                {/* Mark Done — show when confirmed and earner hasn't marked yet */}
                {status === 'confirmed' && !booking.earnerDone && (
                  <TouchableOpacity
                    style={styles.completeBtn}
                    onPress={() => handleMarkDone(booking)}
                  >
                    <Ionicons name="checkmark-done" size={16} color={colors.primary} style={{ marginRight: 6 }} />
                    <Text style={styles.completeBtnText}>I Finished This Job</Text>
                  </TouchableOpacity>
                )}

                {/* Verified result — poster rated earner */}
                {status === 'verified' && booking.earnerRating && (
                  <View style={styles.verifiedRow}>
                    <View style={styles.verifiedStarsRow}>
                      {[1,2,3,4,5].map(s => (
                        <Ionicons key={s} name={s <= Math.round(booking.earnerRating) ? 'star' : 'star-outline'} size={13} color={colors.success} style={{ marginRight: 1 }} />
                      ))}
                      <Text style={styles.verifiedText}>
                        {'  '}{Number(booking.earnerRating).toFixed(1)} from poster
                        {booking.paymentMethod ? ` · Paid via ${booking.paymentMethod}` : ''}
                      </Text>
                    </View>
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
                    <Ionicons name="star" size={15} color="#D97706" style={{ marginRight: 6 }} />
                    <Text style={styles.ratePosterBtnText}>Rate the Poster</Text>
                  </TouchableOpacity>
                )}
                {status === 'verified' && booking.posterRating && (
                  <Text style={styles.posterRatedText}>
                    You rated the poster {booking.posterRating} ★
                  </Text>
                )}

                {/* Message button — any ongoing status (pending/confirmed/completed) */}
                {ONGOING_STATUSES.has(status) && (
                  <TouchableOpacity
                    style={styles.msgBtn}
                    onPress={() => setMsgTarget({
                      bookingId: booking.id,
                      jobTitle: j.title,
                      otherPerson: { id: j.posterId, name: j.poster?.name || 'Poster', avatarInitial: j.poster?.avatarInitial || 'P', avatarUrl: j.poster?.avatarUrl },
                    })}
                  >
                    <Ionicons name="chatbubble-ellipses-outline" size={15} color={colors.textSecondary} style={{ marginRight: 6 }} />
                    <Text style={styles.msgBtnText}>Message Poster</Text>
                  </TouchableOpacity>
                )}

                {/* Cancel / withdraw */}
                {(status === 'pending' || status === 'confirmed') && (
                  <TouchableOpacity style={styles.cancelLink} onPress={() => handleCancel(booking)}>
                    <Text style={styles.cancelLinkText}>{status === 'pending' ? 'Withdraw application' : 'Cancel booking'}</Text>
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
                <TouchableOpacity key={s} onPress={() => { haptic.selection(); setPosterRating(s); }} style={{ marginRight: 4 }}>
                  <Ionicons name={s <= posterRating ? 'star' : 'star-outline'} size={34} color={s <= posterRating ? '#F59E0B' : colors.border} />
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

      {/* Finish Job Modal — optional proof photos */}
      <Modal visible={!!finishTarget} animationType="slide" transparent onRequestClose={() => !finishing && setFinishTarget(null)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => !finishing && setFinishTarget(null)} />
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Finish this job</Text>
            <Text style={styles.modalSub}>
              Add photos as proof of your work (optional). The poster sees these when verifying.
            </Text>

            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }}>
              {finishPhotos.map((u, i) => (
                <View key={i} style={styles.finishThumbWrap}>
                  <Image source={{ uri: u }} style={styles.finishThumb} />
                  <TouchableOpacity
                    style={styles.finishThumbRemove}
                    onPress={() => setFinishPhotos(prev => prev.filter((_, idx) => idx !== i))}
                  >
                    <Ionicons name="close" size={13} color="#fff" />
                  </TouchableOpacity>
                </View>
              ))}
              {finishPhotos.length < 6 && (
                <TouchableOpacity style={styles.addPhotoTile} onPress={handleAddFinishPhotos}>
                  <Ionicons name="camera-outline" size={24} color={colors.primary} />
                  <Text style={styles.addPhotoText}>Add</Text>
                </TouchableOpacity>
              )}
            </ScrollView>

            <TouchableOpacity onPress={handleConfirmFinish} disabled={finishing} activeOpacity={0.85}>
              <LinearGradient colors={gradients.earn} style={styles.submitBtn}>
                {finishing
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.submitBtnText}>{finishPhotos.length ? 'Submit & Mark Complete' : 'Mark Complete'}</Text>
                }
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => !finishing && setFinishTarget(null)} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function SegmentBtn({ label, count, active, onPress }) {
  return (
    <TouchableOpacity style={[styles.segBtn, active && styles.segBtnActive]} onPress={onPress} activeOpacity={0.8}>
      <Text style={[styles.segText, active && styles.segTextActive]}>
        {label}{count > 0 ? ` (${count})` : ''}
      </Text>
    </TouchableOpacity>
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
  titleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  screenTitle: { fontSize: 22, fontWeight: '800', color: '#fff' },
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
  streakText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  xpWrap: { flex: 1 },
  segment: {
    flexDirection: 'row', marginHorizontal: 16, marginTop: 16,
    backgroundColor: colors.surface, borderRadius: 14, padding: 4,
    borderWidth: 1, borderColor: colors.border,
  },
  segBtn: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: 10 },
  segBtnActive: { backgroundColor: colors.primary },
  segText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  segTextActive: { color: '#fff' },
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
  bookingIcon: { marginRight: 6, marginTop: 2 },
  bookingText: { fontSize: 12, color: colors.textSecondary, flex: 1, lineHeight: 18 },
  bookingBold: { fontWeight: '800', color: colors.primary },
  inProgressBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#ECFDF5', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6, marginTop: 8, alignSelf: 'flex-start',
  },
  inProgressText: { fontSize: 12, fontWeight: '700', color: colors.success },
  amendCard: {
    backgroundColor: '#FFFBEB', borderRadius: 12, padding: 12, marginTop: 10,
    borderWidth: 1.5, borderColor: '#FCD34D',
  },
  amendCardTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  amendCardTitle: { fontSize: 13, fontWeight: '800', color: '#D97706' },
  amendCardNote: { fontSize: 13, color: colors.textPrimary, lineHeight: 19, marginBottom: 10 },
  amendCardActions: { flexDirection: 'row', gap: 10 },
  amendAcceptBtn: {
    flex: 1, flexDirection: 'row', backgroundColor: colors.success, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center', justifyContent: 'center',
  },
  amendAcceptText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  amendDeclineBtn: {
    flex: 1, flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: colors.border,
  },
  amendDeclineText: { color: colors.textSecondary, fontSize: 13, fontWeight: '700' },
  amendStatusBanner: {
    backgroundColor: '#ECFDF5', borderRadius: 8, padding: 9, marginTop: 8,
  },
  amendStatusText: { fontSize: 12, fontWeight: '600', color: '#059669' },
  waitingBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#FFF7ED', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6, marginTop: 8,
  },
  waitingText: { fontSize: 12, fontWeight: '600', color: '#D97706' },
  completeBtn: {
    flexDirection: 'row', backgroundColor: colors.primaryLight, borderRadius: 12,
    paddingVertical: 12, alignItems: 'center', justifyContent: 'center', marginTop: 12,
    borderWidth: 1.5, borderColor: colors.primary,
  },
  completeBtnText: { fontSize: 14, fontWeight: '800', color: colors.primary },
  verifiedRow: {
    backgroundColor: colors.accentLight, borderRadius: 10,
    padding: 10, marginTop: 8,
  },
  verifiedStarsRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  verifiedText: { fontSize: 13, fontWeight: '700', color: colors.success },
  reviewQuote: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', marginTop: 3 },
  ratePosterBtn: {
    flexDirection: 'row', borderRadius: 12, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', marginTop: 8,
    borderWidth: 1.5, borderColor: colors.gold, backgroundColor: '#FFFBEB',
  },
  ratePosterBtnText: { fontSize: 13, fontWeight: '700', color: '#D97706' },
  posterRatedText: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', marginTop: 8, textAlign: 'center' },
  msgBtn: {
    flexDirection: 'row', borderRadius: 12, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', marginTop: 8,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface,
  },
  msgBtnText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  cancelLink: { paddingVertical: 10, alignItems: 'center', marginTop: 4 },
  cancelLinkText: { fontSize: 13, fontWeight: '700', color: colors.urgent },
  photoStrip: { marginTop: 10 },
  photoStripLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 },
  photoThumb: { width: 64, height: 64, borderRadius: 10, marginRight: 8, backgroundColor: colors.border },
  finishThumbWrap: { marginRight: 10 },
  finishThumb: { width: 80, height: 80, borderRadius: 12, backgroundColor: colors.border },
  finishThumbRemove: {
    position: 'absolute', top: -6, right: -6,
    width: 22, height: 22, borderRadius: 11, backgroundColor: colors.urgent,
    alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff',
  },
  addPhotoTile: {
    width: 80, height: 80, borderRadius: 12, borderWidth: 1.5, borderColor: colors.primary,
    borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primaryLight,
  },
  addPhotoText: { fontSize: 11, fontWeight: '700', color: colors.primary, marginTop: 2 },
  noGigsCard: {
    backgroundColor: colors.surface, borderRadius: 14, padding: 24,
    alignItems: 'center', borderWidth: 1, borderColor: colors.border,
  },
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
