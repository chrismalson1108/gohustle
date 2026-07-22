import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, Alert, Modal, TextInput,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useStripe } from '@stripe/stripe-react-native';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import BookingStatusBadge from '../components/BookingStatusBadge';
import CompletionModal from '../components/CompletionModal';
import MessageSheet from '../components/MessageSheet';
import Avatar from '../components/Avatar';
import ScreenHeader from '../components/ScreenHeader';
import SignedImage from '../components/SignedImage';
import { skillFitScore } from '../lib/filters';
import { useTabBarScrollHandler } from '../lib/tabBarScroll';
import { colors, radii, shadows } from '../theme';

const ACTIVE_STATUSES  = new Set(['pending', 'confirmed', 'completed']);
const PAST_STATUSES    = new Set(['verified', 'declined', 'cancelled']);

// Bump cooldown: a gig can only jump to the top of Browse once per 24h, so a poster
// can't pin their listings above every organic one by tapping Bump on a timer.
const BUMP_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const bumpCooldownRemaining = (job) => {
  if (!job?.bumpedAt) return 0;
  const elapsed = Date.now() - new Date(job.bumpedAt).getTime();
  return Number.isFinite(elapsed) ? Math.max(0, BUMP_COOLDOWN_MS - elapsed) : 0;
};

// Applicant sort options for a gig's request list.
const APPLICANT_SORTS = [
  { id: 'newest', label: 'Newest' },
  { id: 'wage',   label: 'Wage' },
  { id: 'rating', label: 'Rating' },
  { id: 'fit',    label: 'Fit' },
];

// Sort one gig's applicant bookings by the chosen key. Returns a new array; the
// default 'newest' keeps the incoming (created-desc) order untouched.
function sortApplicants(reqs, job, sortBy) {
  if (sortBy === 'newest') return reqs;
  const wage = (b) => (b.counterOffer ?? job.pay);
  const copy = [...reqs];
  if (sortBy === 'wage')        copy.sort((a, b) => wage(a) - wage(b)); // cheapest first
  else if (sortBy === 'rating') copy.sort((a, b) => (b.earner?.rating ?? 0) - (a.earner?.rating ?? 0));
  else if (sortBy === 'fit')    copy.sort((a, b) => skillFitScore(job, b.earner?.skills) - skillFitScore(job, a.earner?.skills));
  return copy;
}

// Alert.alert is a no-op on Expo web, so a destructive confirm dialog silently does
// nothing there (the action can never fire). Fall back to window.confirm on web; keep
// the native two-button Alert everywhere else so behavior is unchanged on device.
function confirmDestructive({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm }) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: cancelLabel, style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}

export default function GigsScreen({ navigation }) {
  const {
    postedJobs, posterBookings,
    acceptBooking, declineBooking, cancelBooking, cancellationFeeFor,
    markPosterDone, verifyAndRate, deleteJob, bumpJob,
    refreshJobs, refreshPosterBookings,
    proposeAmendment, createPaymentIntent, getPaymentMethodStatus,
  } = useJobs();
  const { showToast } = useUser();
  const haptic = useHaptic();
  const onTabBarScroll = useTabBarScrollHandler();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const [tab, setTab]                   = useState('active'); // 'active' | 'past'
  const [sortBy, setSortBy]             = useState('newest'); // applicant sort, shared across gigs
  const [expanded, setExpanded]         = useState({});
  const [loadingId, setLoadingId]       = useState(null);
  const [verifyTarget, setVerifyTarget] = useState(null);
  const [msgTarget, setMsgTarget]       = useState(null);
  const [refreshing, setRefreshing]     = useState(false);
  const [amendTarget, setAmendTarget]   = useState(null); // { bookingId, earnerName }
  const [amendNote, setAmendNote]       = useState('');
  const [hasCard, setHasCard]           = useState(true); // optimistic until checked

  // Refresh from DB every time this tab gains focus
  useFocusEffect(
    useCallback(() => {
      refreshJobs();
      refreshPosterBookings();
      getPaymentMethodStatus().then(s => setHasCard(s.hasPaymentMethod)).catch(() => {});
    }, [])
  );

  // Group bookings by jobId
  const bookingsByJob = posterBookings.reduce((acc, b) => {
    const id = b.jobId;
    if (!acc[id]) acc[id] = [];
    acc[id].push(b);
    return acc;
  }, {});

  // Past = completed/declined booking history (read-only)
  const pastBookings = posterBookings.filter(b => PAST_STATUSES.has(b.status));

  // Active list = open listings + any gig that still has active bookings, including
  // gigs the poster deleted but that have unresolved bookings. Without this, those
  // bookings are invisible yet still counted in the tab badge ("ghost" count).
  const postedById = {};
  postedJobs.forEach(j => { postedById[j.id] = j; });
  const orphanIds = [...new Set(
    posterBookings
      .filter(b => ACTIVE_STATUSES.has(b.status) && !postedById[b.jobId])
      .map(b => b.jobId)
  )];
  const phantomJobs = orphanIds.map(id => {
    const b = posterBookings.find(x => x.jobId === id);
    return {
      id,
      title: b?.job?.title || 'Removed gig',
      pay: b?.job?.pay,
      payType: b?.job?.payType,
      location: 'Gig removed',
      status: 'cancelled',
      removed: true,
    };
  });
  const activeJobs = [...postedJobs, ...phantomJobs];

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshJobs(), refreshPosterBookings()]);
    setRefreshing(false);
  };

  const toggleExpand = (jobId) =>
    setExpanded(prev => ({ ...prev, [jobId]: !prev[jobId] }));

  const handleDelete = (job) => {
    const bookings = bookingsByJob[job.id] || [];
    const activeBookings = bookings.filter(b => ['pending', 'confirmed', 'completed'].includes(b.status));
    if (activeBookings.length > 0) {
      // showToast (not Alert) so the guard notice is visible on web too, where
      // Alert.alert is a no-op.
      showToast({ icon: '⚠️', title: 'Cannot delete', message: 'This gig has active or unverified bookings. Decline pending requests and verify any completed work before deleting.' });
      return;
    }
    confirmDestructive({
      title: 'Delete Gig?',
      message: `"${job.title}" will be removed from Browse and no one can book it.`,
      confirmLabel: 'Delete',
      onConfirm: () => { haptic.medium(); deleteJob(job.id); },
    });
  };

  const handleAccept = async (bookingId) => {
    haptic.medium();
    setLoadingId(bookingId);
    try {
      // 1. Create escrow PaymentIntent on the server
      const { clientSecret, customerId, ephemeralKey, amountCents } =
        await createPaymentIntent(bookingId);

      // 2. Initialize Stripe's payment sheet with the card UI
      const { error: initErr } = await initPaymentSheet({
        merchantDisplayName: 'GoHustlr',
        customerId,
        customerEphemeralKeySecret: ephemeralKey,
        paymentIntentClientSecret: clientSecret,
        allowsDelayedPaymentMethods: false,
        appearance: {
          colors: { primary: colors.primary },
        },
      });
      if (initErr) throw new Error(initErr.message);

      // 3. Present sheet — user enters card details
      const { error: payErr } = await presentPaymentSheet();
      if (payErr) {
        // User cancelled — not a real error
        if (payErr.code !== 'Canceled') {
          showToast({ icon: '❌', title: 'Payment Failed', message: payErr.message });
        }
        setLoadingId(null);
        return;
      }

      // 4. Card authorized → confirm booking in DB
      haptic.success();
      await acceptBooking(bookingId);
      const dollars = (amountCents / 100).toFixed(2);
      showToast({ icon: '✅', title: 'Booking Accepted!', message: `$${dollars} held in escrow. Released to earner after verification.` });
    } catch (err) {
      const msg = err?.message || 'Something went wrong';
      if (err?.code === 'EARNER_NO_PAYOUT') {
        showToast({ icon: '⚠️', title: 'Earner Not Ready', message: "The earner hasn't set up their payout account yet. They need to connect their bank before you can accept." });
      } else {
        showToast({ icon: '❌', title: 'Payment Error', message: msg });
      }
    }
    setLoadingId(null);
  };

  const handleDecline = async (bookingId) => {
    haptic.medium();
    setLoadingId(bookingId);
    await declineBooking(bookingId);
    setLoadingId(null);
  };

  const handleCancel = (booking) => {
    // Cancellation-fee POLICY (display + record only — no money is charged here).
    const fee = cancellationFeeFor ? cancellationFeeFor(booking.id) : 0;
    const message = fee > 0
      ? `Cancelling now applies a cancellation fee of $${fee} to the worker. This releases the payment hold and notifies them.`
      : 'This cancels the confirmed gig and releases the payment hold. The earner will be notified.';
    confirmDestructive({
      title: 'Cancel this booking?',
      message,
      confirmLabel: 'Cancel gig',
      cancelLabel: 'Keep',
      onConfirm: async () => {
        haptic.medium();
        setLoadingId(booking.id);
        // Gate on the real result — cancelBooking refuses (returns false) when the
        // booking can't be cancelled and emits its own failure toast. Don't claim
        // the hold was released / a fee recorded if nothing was cancelled.
        const ok = await cancelBooking(booking.id);
        setLoadingId(null);
        if (ok === false) { haptic.error(); return; }
        showToast({ icon: '❌', title: 'Booking cancelled', message: fee > 0 ? `A $${fee} cancellation fee was recorded.` : 'The payment hold was released.' });
      },
    });
  };

  const handleMarkDone = async (booking) => {
    haptic.success();
    setLoadingId(booking.id);
    await markPosterDone(booking.id);
    setLoadingId(null);
    if (booking.earnerDone) {
      showToast({ icon: '🎉', title: 'Job Complete!', message: 'Both parties confirmed. Now verify and rate the earner.' });
    } else {
      showToast({ icon: '✅', title: 'Marked Done!', message: "Waiting for the earner to confirm their side." });
    }
  };

  const handleVerify = async (data) => {
    if (!verifyTarget) return;
    try {
      await verifyAndRate(verifyTarget.id, data);
      showToast({ icon: '⭐', title: 'Job Verified!', message: 'Rating submitted and job marked complete.' });
    } catch (e) {
      showToast({ icon: '⚠️', title: 'Could not verify', message: e?.message || 'Please try again.' });
      throw e; // keep the modal open so the poster can retry
    }
  };

  const handleProposeAmendment = async () => {
    if (!amendTarget || !amendNote.trim()) return;
    // Gate on the real write — proposeAmendment returns false when the note is blocked
    // by the content filter or the DB rejects it, and surfaces its own specific toast
    // (mirrors ratePoster), so don't show a generic message that would mask the reason.
    const ok = await proposeAmendment(amendTarget.bookingId, amendNote.trim());
    if (ok === false) { haptic.error(); return; }
    showToast({ icon: '📝', title: 'Change Proposed', message: `${amendTarget.earnerName} will be notified to approve or decline.` });
    setAmendTarget(null);
    setAmendNote('');
  };

  const pendingCount = posterBookings.filter(b => b.status === 'pending' || b.status === 'completed').length;

  return (
    <View style={styles.container}>
      <ScreenHeader>
        <View style={styles.headerRow}>
          <View style={styles.headerTitleRow}>
            <Ionicons name="megaphone" size={22} color={colors.textPrimary} style={{ marginRight: 8 }} />
            <Text style={styles.headerTitle} numberOfLines={1}>Hire</Text>
          </View>
          <Text style={styles.headerSub} numberOfLines={2}>
            {postedJobs.length === 0
              ? 'Post your first gig to start hiring'
              : `${postedJobs.length} gig${postedJobs.length !== 1 ? 's' : ''} posted${pendingCount > 0 ? ` · ${pendingCount} need attention` : ''}`}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.postBtn}
          onPress={() => navigation.navigate('PostJob')}
          activeOpacity={0.85}
        >
          <Ionicons name="add" size={20} color="#fff" style={{ marginRight: 6 }} />
          <Text style={styles.postBtnText} numberOfLines={1}>Post new gig</Text>
        </TouchableOpacity>
      </ScreenHeader>

      {/* Segmented control */}
      <View style={styles.segment}>
        <SegmentBtn label="Active" count={postedJobs.length}   active={tab === 'active'} onPress={() => { haptic.selection(); setTab('active'); }} />
        <SegmentBtn label="Past"   count={pastBookings.length} active={tab === 'past'}   onPress={() => { haptic.selection(); setTab('past'); }} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 140 }}
        onScroll={onTabBarScroll}
        scrollEventThrottle={32}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {!hasCard && (
          <TouchableOpacity
            style={styles.payAlert}
            onPress={() => { haptic.medium(); navigation.navigate('ProfileTab', { screen: 'PayoutSetup', initial: false }); }}
            activeOpacity={0.85}
          >
            <Ionicons name="card" size={18} color={colors.primary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.payAlertTitle} numberOfLines={1}>Add a payment method to hire</Text>
              <Text style={styles.payAlertSub} numberOfLines={2}>Save a card so you can accept bookings →</Text>
            </View>
          </TouchableOpacity>
        )}

        {/* ===== ACTIVE: posted listings + current bookings ===== */}
        {tab === 'active' && activeJobs.length === 0 && (
          <View style={styles.empty}>
            <Ionicons name="briefcase-outline" size={52} color={colors.textMuted} style={{ marginBottom: 16 }} />
            <Text style={styles.emptyTitle}>No gigs posted yet</Text>
            <Text style={styles.emptyText}>Tap "Post new gig" above to create your first listing.</Text>
          </View>
        )}

        {tab === 'active' && activeJobs.map(job => {
          const allBookings = bookingsByJob[job.id] || [];
          const jobBookings = sortApplicants(allBookings.filter(b => ACTIVE_STATUSES.has(b.status)), job, sortBy);
          const isOpen      = job.status === 'open';
          const isExpanded  = expanded[job.id] ?? (jobBookings.length > 0);
          const pendingN    = jobBookings.filter(b => b.status === 'pending').length;
          const confirmedN  = jobBookings.filter(b => b.status === 'confirmed').length;
          const completedN  = jobBookings.filter(b => b.status === 'completed').length;

          return (
            <View key={job.id} style={styles.jobSection}>
              {/* Job header */}
              <TouchableOpacity
                style={styles.jobCard}
                onPress={() => toggleExpand(job.id)}
                activeOpacity={0.85}
              >
                <View style={styles.jobCardTop}>
                  <View style={styles.jobCardInfo}>
                    <Text style={styles.jobTitle} numberOfLines={1}>{job.title}</Text>
                    <Text style={styles.jobMeta} numberOfLines={1}>
                      {job.payType === 'hourly' ? `$${job.pay}/hr` : `$${job.pay} flat`}
                      {'  ·  '}{job.location}
                    </Text>
                  </View>
                  <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} style={{ marginLeft: 8, marginTop: 2 }} />
                </View>

                {/* Booking summary chips */}
                <View style={styles.chipRow}>
                  {isOpen && jobBookings.length === 0 && (
                    <Chip ion="ellipse" color={colors.success} bg={colors.successLight} label="Live" />
                  )}
                  {pendingN > 0 && (
                    <Chip ion="time" color={colors.accentDeep} bg={colors.accentLight} label={`${pendingN} Pending`} />
                  )}
                  {confirmedN > 0 && (
                    <Chip ion="checkmark-circle" color={colors.success} bg={colors.successLight} label={`${confirmedN} In progress`} />
                  )}
                  {completedN > 0 && (
                    <Chip ion="sync" color={colors.accentDeep} bg={colors.accentLight} label={`${completedN} Needs verify`} />
                  )}
                </View>

                {/* Job actions — hidden for removed gigs */}
                {job.removed ? (
                  <View style={styles.removedNote}>
                    <Ionicons name="alert-circle-outline" size={14} color={colors.accentDeep} style={{ marginRight: 6 }} />
                    <Text style={styles.removedNoteText} numberOfLines={2}>This gig was removed — resolve the bookings below.</Text>
                  </View>
                ) : (
                  <View style={styles.jobActions}>
                    <TouchableOpacity
                      style={[styles.editBtn, bumpCooldownRemaining(job) > 0 && styles.editBtnDim]}
                      onPress={async () => {
                        const remaining = bumpCooldownRemaining(job);
                        if (remaining > 0) {
                          haptic.error();
                          const hrs = Math.ceil(remaining / (60 * 60 * 1000));
                          showToast({ icon: '⏳', title: 'Already bumped', message: `You can bump this gig again in about ${hrs}h.` });
                          return;
                        }
                        haptic.light();
                        // Gate success on the real write — bumpJob returns false on failure.
                        const ok = await bumpJob(job.id);
                        if (ok === false) { haptic.error(); showToast({ icon: '⚠️', title: "Couldn't bump", message: 'Please try again.' }); return; }
                        showToast({ icon: '🚀', title: 'Bumped!', message: 'Your gig jumped to the top of Browse.' });
                      }}
                    >
                      <Ionicons name="arrow-up-outline" size={15} color={colors.textSecondary} style={{ marginRight: 6 }} />
                      <Text style={styles.editBtnText} numberOfLines={1}>Bump</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.editBtn}
                      onPress={() => navigation.navigate('EditJob', { jobId: job.id })}
                    >
                      <Ionicons name="create-outline" size={15} color={colors.textSecondary} style={{ marginRight: 6 }} />
                      <Text style={styles.editBtnText} numberOfLines={1}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.editBtn}
                      onPress={() => { haptic.light(); navigation.navigate('PostJob', { prefill: job }); }}
                    >
                      <Ionicons name="copy-outline" size={15} color={colors.textSecondary} style={{ marginRight: 6 }} />
                      <Text style={styles.editBtnText} numberOfLines={1}>Duplicate</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.deleteBtn}
                      onPress={() => handleDelete(job)}
                    >
                      <Ionicons name="trash-outline" size={15} color={colors.urgent} style={{ marginRight: 6 }} />
                      <Text style={styles.deleteBtnText} numberOfLines={1}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </TouchableOpacity>

              {/* Expanded bookings */}
              {isExpanded && (
                <View style={styles.bookingsList}>
                  {jobBookings.length > 1 && (
                    <View style={styles.sortRow}>
                      <Text style={styles.sortLabel}>Sort</Text>
                      {APPLICANT_SORTS.map(s => (
                        <TouchableOpacity
                          key={s.id}
                          style={[styles.sortChip, sortBy === s.id && styles.sortChipActive]}
                          onPress={() => { haptic.selection(); setSortBy(s.id); }}
                          activeOpacity={0.8}
                        >
                          <Text style={[styles.sortChipText, sortBy === s.id && styles.sortChipTextActive]} numberOfLines={1}>{s.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                  {jobBookings.length === 0 ? (
                    <View style={styles.noApplicants}>
                      <Text style={styles.noApplicantsText}>No active applicants — your gig is live on Browse.</Text>
                    </View>
                  ) : (
                    jobBookings.map(booking => (
                      <BookingRow
                        key={booking.id}
                        booking={booking}
                        jobTitle={job.title}
                        loading={loadingId === booking.id}
                        onAccept={() => handleAccept(booking.id)}
                        onDecline={() => handleDecline(booking.id)}
                        onMarkDone={() => handleMarkDone(booking)}
                        onCancel={() => handleCancel(booking)}
                        onVerify={() => setVerifyTarget(booking)}
                        onMessage={() => setMsgTarget({
                          bookingId: booking.id,
                          jobTitle: job.title,
                          otherPerson: {
                            id: booking.earner?.id,
                            name: booking.earner?.name || 'Earner',
                            avatarInitial: booking.earner?.avatarInitial || 'E',
                            avatarUrl: booking.earner?.avatarUrl,
                          },
                        })}
                        onRequestChange={booking.status === 'confirmed'
                          ? () => { setAmendTarget({ bookingId: booking.id, earnerName: booking.earner?.name || 'Earner' }); setAmendNote(''); }
                          : null
                        }
                        onViewEarner={booking.earner?.id ? () => navigation.navigate('UserProfile', { userId: booking.earner.id }) : null}
                      />
                    ))
                  )}
                </View>
              )}
            </View>
          );
        })}

        {/* ===== PAST: completed / declined history ===== */}
        {tab === 'past' && pastBookings.length === 0 && (
          <View style={styles.empty}>
            <Ionicons name="time-outline" size={52} color={colors.textMuted} style={{ marginBottom: 16 }} />
            <Text style={styles.emptyTitle}>No past gigs yet</Text>
            <Text style={styles.emptyText}>Completed and declined bookings will show up here.</Text>
          </View>
        )}

        {tab === 'past' && pastBookings.map(booking => (
          <PastBookingCard
            key={booking.id}
            booking={booking}
            onViewEarner={booking.earner?.id ? () => navigation.navigate('UserProfile', { userId: booking.earner.id }) : null}
            onRebook={booking.earner?.id ? () => {
              haptic.light();
              // Full job row (all fields) if it's still cached; the booking's thin
              // job embed (title/pay/payType/location) is the fallback.
              const fullJob = postedJobs.find(j => j.id === booking.jobId);
              navigation.navigate('PostJob', {
                prefill: fullJob || booking.job,
                rebookEarner: { id: booking.earner.id, name: booking.earner.name },
              });
            } : null}
          />
        ))}
      </ScrollView>

      <CompletionModal
        visible={!!verifyTarget}
        booking={verifyTarget}
        onClose={() => setVerifyTarget(null)}
        onConfirm={handleVerify}
      />
      <MessageSheet
        visible={!!msgTarget}
        bookingId={msgTarget?.bookingId}
        jobTitle={msgTarget?.jobTitle}
        otherPerson={msgTarget?.otherPerson}
        onClose={() => setMsgTarget(null)}
      />

      {/* Amendment proposal modal */}
      <Modal visible={!!amendTarget} animationType="slide" transparent onRequestClose={() => setAmendTarget(null)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setAmendTarget(null)} />
          <View style={styles.amendModal}>
            <View style={styles.amendModalHandle} />
            <View style={styles.amendModalTitleRow}>
              <Ionicons name="document-text-outline" size={18} color={colors.textPrimary} style={{ marginRight: 8 }} />
              <Text style={styles.amendModalTitle} numberOfLines={1}>Propose a change</Text>
            </View>
            <Text style={styles.amendModalSub}>
              Describe what you'd like to update. {amendTarget?.earnerName} will need to approve it before any core terms change.
            </Text>
            <TextInput
              style={styles.amendInput}
              placeholder="e.g. Need to shift time to 3pm, or pay will be $60 instead of $50…"
              placeholderTextColor={colors.textMuted}
              value={amendNote}
              onChangeText={setAmendNote}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              autoFocus
            />
            <TouchableOpacity
              style={[styles.amendSubmitBtn, !amendNote.trim() && styles.amendSubmitBtnDisabled]}
              onPress={handleProposeAmendment}
              disabled={!amendNote.trim()}
            >
              <Text
                style={[styles.amendSubmitText, !amendNote.trim() && styles.amendSubmitTextDisabled]}
                numberOfLines={1}
              >
                Send to {amendTarget?.earnerName} →
              </Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function SegmentBtn({ label, count, active, onPress }) {
  return (
    <TouchableOpacity style={[styles.segBtn, active && styles.segBtnActive]} onPress={onPress} activeOpacity={0.8}>
      <Text style={[styles.segText, active && styles.segTextActive]} numberOfLines={1}>
        {label}{count > 0 ? ` (${count})` : ''}
      </Text>
    </TouchableOpacity>
  );
}

function CompletionStrip({ photos, label = 'Completion photos' }) {
  if (!photos?.length) return null;
  return (
    <View style={styles.photoStrip}>
      <Text style={styles.photoStripLabel}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {photos.map((u, i) => (
          <SignedImage key={i} value={u} bucket="completion-photos" style={styles.photoThumb} />
        ))}
      </ScrollView>
    </View>
  );
}

function Chip({ ion, color, bg, label }) {
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <Ionicons name={ion} size={11} color={color} style={{ marginRight: 5 }} />
      <Text style={[styles.chipText, { color }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

function PastBookingCard({ booking, onViewEarner, onRebook }) {
  const earnerName = booking.earner?.name || 'Someone';
  const initial    = booking.earner?.avatarInitial || earnerName[0]?.toUpperCase() || '?';
  const declined   = booking.status === 'declined';

  return (
    <View style={styles.pastCard}>
      <View style={styles.earnerRow}>
        <TouchableOpacity style={styles.earnerTap} onPress={onViewEarner} disabled={!onViewEarner} activeOpacity={0.7}>
          <Avatar
            url={booking.earner?.avatarUrl}
            initial={initial}
            size={38}
            fontSize={15}
            bg={declined ? colors.textMuted : colors.primary}
            style={{ marginRight: 10 }}
          />
          <View style={styles.earnerInfo}>
            <Text style={styles.jobTitle} numberOfLines={1}>{booking.job?.title || 'Gig'}</Text>
            <Text style={styles.earnerName} numberOfLines={1}>{earnerName}</Text>
          </View>
        </TouchableOpacity>
        <BookingStatusBadge status={booking.status} compact />
      </View>
      {!declined && (
        <View style={styles.pastRatingRow}>
          {booking.earnerRating ? (
            <View style={styles.pastStars}>
              {[1,2,3,4,5].map(s => (
                <Ionicons key={s} name={s <= Math.round(booking.earnerRating) ? 'star' : 'star-outline'} size={13} color={colors.accent} style={{ marginRight: 1 }} />
              ))}
              <Text style={styles.pastRatingText} numberOfLines={1}>  You rated {earnerName} {Number(booking.earnerRating).toFixed(1)}</Text>
            </View>
          ) : (
            <Text style={styles.pastRatingText} numberOfLines={1}>Completed</Text>
          )}
          {booking.posterRating ? (
            <Text style={styles.pastRatingText} numberOfLines={1}>{earnerName} rated you {booking.posterRating} ★</Text>
          ) : null}
        </View>
      )}
      <CompletionStrip photos={booking.beforePhotos} label="Before" />
      <CompletionStrip photos={booking.completionPhotos} label={booking.beforePhotos?.length ? 'After' : 'Completion photos'} />
      {!declined && onRebook && (
        <TouchableOpacity style={styles.rebookBtn} onPress={onRebook} activeOpacity={0.85}>
          <Ionicons name="refresh" size={15} color={colors.textSecondary} style={{ marginRight: 6 }} />
          <Text style={styles.rebookBtnText} numberOfLines={1}>Rebook {earnerName}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function BookingRow({ booking, jobTitle, loading, onAccept, onDecline, onMarkDone, onCancel, onVerify, onMessage, onRequestChange, onViewEarner }) {
  const earnerName = booking.earner?.name || 'Someone';
  const initial    = booking.earner?.avatarInitial || earnerName[0]?.toUpperCase() || '?';
  const status     = booking.status;

  return (
    <View style={styles.bookingRow}>
      {/* Earner info */}
      <View style={styles.earnerRow}>
        <TouchableOpacity style={styles.earnerTap} onPress={onViewEarner} disabled={!onViewEarner} activeOpacity={0.7}>
          <Avatar url={booking.earner?.avatarUrl} initial={initial} size={38} fontSize={15} style={{ marginRight: 10 }} />
          <View style={styles.earnerInfo}>
            <Text style={styles.earnerName} numberOfLines={1}>{earnerName}</Text>
            {booking.earner?.reviewCount > 0 ? (
              <View style={styles.ratingRow}>
                <Ionicons name="star" size={11} color={colors.accent} style={{ marginRight: 3 }} />
                <Text style={styles.earnerRating} numberOfLines={1}>{Number(booking.earner.rating).toFixed(1)}</Text>
              </View>
            ) : <Text style={styles.earnerRating} numberOfLines={1}>New</Text>}
          </View>
        </TouchableOpacity>
        <BookingStatusBadge status={status} compact />
      </View>

      {booking.slotLabel && (
        <View style={styles.metaRow}>
          <Ionicons name="calendar-outline" size={12} color={colors.textMuted} style={styles.metaIcon} />
          <Text style={styles.metaText} numberOfLines={2}>{booking.slotLabel}</Text>
        </View>
      )}
      {booking.counterOffer && (
        <View style={styles.metaRow}>
          <Ionicons name="chatbubble-outline" size={12} color={colors.textMuted} style={styles.metaIcon} />
          <Text style={styles.metaText} numberOfLines={1}>
            Counter-offer: <Text style={styles.counterVal}>${booking.counterOffer}</Text>
          </Text>
        </View>
      )}
      {booking.applicationNote ? (
        <View style={styles.noteQuote}>
          <Text style={styles.noteQuoteText}>&ldquo;{booking.applicationNote}&rdquo;</Text>
        </View>
      ) : null}

      {/* In-progress + done flags */}
      {status === 'confirmed' && (
        <View style={styles.inProgressRow}>
          <View style={styles.inlineRow}>
            <Ionicons name="ellipse" size={9} color={booking.startedAt ? colors.success : colors.textMuted} style={{ marginRight: 6 }} />
            <Text style={[styles.inProgressText, !booking.startedAt && { color: colors.textMuted }]} numberOfLines={1}>
              {booking.startedAt ? 'In progress · Worker on site' : 'Confirmed · Not started yet'}
            </Text>
          </View>
          {(booking.earnerDone || booking.posterDone) && (
            <View style={styles.doneFlags}>
              <View style={styles.inlineRow}>
                <Ionicons name={booking.earnerDone ? 'checkbox' : 'square-outline'} size={13} color={booking.earnerDone ? colors.success : colors.textMuted} style={{ marginRight: 5 }} />
                <Text style={[styles.doneFlag, booking.earnerDone && styles.doneFlagDone]} numberOfLines={1}>Earner done</Text>
              </View>
              <View style={[styles.inlineRow, { marginLeft: 16 }]}>
                <Ionicons name={booking.posterDone ? 'checkbox' : 'square-outline'} size={13} color={booking.posterDone ? colors.success : colors.textMuted} style={{ marginRight: 5 }} />
                <Text style={[styles.doneFlag, booking.posterDone && styles.doneFlagDone]} numberOfLines={1}>You done</Text>
              </View>
            </View>
          )}
        </View>
      )}

      <CompletionStrip photos={booking.beforePhotos} label="Before" />
      <CompletionStrip photos={booking.completionPhotos} label={booking.beforePhotos?.length ? 'After' : 'Completion photos'} />

      {/* Actions */}
      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 12 }} />
      ) : (
        <View style={styles.actions}>
          {status === 'pending' && (
            <>
              <TouchableOpacity style={styles.acceptBtn} onPress={onAccept}>
                <Ionicons name="checkmark" size={15} color={colors.success} style={{ marginRight: 6 }} />
                <Text style={styles.acceptText} numberOfLines={1}>Accept</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.declineBtn} onPress={onDecline}>
                <Ionicons name="close" size={15} color={colors.urgent} style={{ marginRight: 6 }} />
                <Text style={styles.declineText} numberOfLines={1}>Decline</Text>
              </TouchableOpacity>
            </>
          )}
          {status === 'confirmed' && !booking.posterDone && (
            <TouchableOpacity style={styles.markDoneBtn} onPress={onMarkDone}>
              <Ionicons name="checkmark-done" size={15} color="#fff" style={{ marginRight: 6 }} />
              <Text style={styles.markDoneText} numberOfLines={1}>Mark job done</Text>
            </TouchableOpacity>
          )}
          {status === 'confirmed' && booking.posterDone && !booking.earnerDone && (
            <View style={styles.waitingBanner}>
              <Ionicons name="hourglass-outline" size={13} color={colors.accentDeep} style={{ marginRight: 6 }} />
              <Text style={styles.waitingText} numberOfLines={2}>Waiting for earner to confirm…</Text>
            </View>
          )}
          {status === 'completed' && (
            <TouchableOpacity style={styles.verifyBtn} onPress={onVerify} activeOpacity={0.85}>
              <Ionicons name="star" size={15} color="#fff" style={{ marginRight: 6 }} />
              <Text style={styles.verifyText} numberOfLines={1}>Verify & rate {earnerName}</Text>
            </TouchableOpacity>
          )}
          {ACTIVE_STATUSES.has(status) && (
            <TouchableOpacity style={styles.msgBtn} onPress={onMessage}>
              <Ionicons name="chatbubble-ellipses-outline" size={15} color={colors.textSecondary} style={{ marginRight: 6 }} />
              <Text style={styles.msgBtnText} numberOfLines={1}>Message {earnerName}</Text>
            </TouchableOpacity>
          )}
          {onRequestChange && booking.amendmentStatus === 'none' && (
            <TouchableOpacity style={styles.changeBtn} onPress={onRequestChange}>
              <Ionicons name="document-text-outline" size={15} color={colors.textSecondary} style={{ marginRight: 6 }} />
              <Text style={styles.changeBtnText} numberOfLines={1}>Request change</Text>
            </TouchableOpacity>
          )}
          {booking.amendmentStatus === 'pending' && (
            <View style={styles.amendPendingBanner}>
              <Text style={styles.amendPendingText} numberOfLines={2}>Change proposed — waiting for {earnerName} to respond</Text>
            </View>
          )}
          {booking.amendmentStatus === 'accepted' && (
            <View style={styles.amendAcceptedBanner}>
              <Text style={styles.amendAcceptedText} numberOfLines={2}>Change accepted — edit your gig in the Edit screen</Text>
            </View>
          )}
          {booking.amendmentStatus === 'declined' && (
            <View style={styles.amendDeclinedBanner}>
              <Text style={styles.amendDeclinedText} numberOfLines={2}>Change declined — original terms remain</Text>
            </View>
          )}
          {status === 'confirmed' && onCancel && !booking.startedAt && (
            <TouchableOpacity style={styles.cancelLink} onPress={onCancel}>
              <Text style={styles.cancelLinkText} numberOfLines={1}>Cancel booking</Text>
            </TouchableOpacity>
          )}
          {status === 'confirmed' && booking.startedAt && (
            <Text style={styles.cancelLockedText}>Can't cancel — the worker has started. Open a dispute if there's a problem.</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  // ---- Header ----
  headerRow: { marginBottom: 16 },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  headerTitle: {
    fontSize: 24, fontWeight: '700', color: colors.textPrimary,
    letterSpacing: -0.4, flexShrink: 1,
  },
  headerSub: { fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
  postBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radii.md, paddingVertical: 14, paddingHorizontal: 20,
  },
  postBtnText: { color: '#fff', fontSize: 15, fontWeight: '700', flexShrink: 1 },

  // ---- Segmented control ----
  segment: {
    flexDirection: 'row', marginHorizontal: 16, marginTop: 8,
    backgroundColor: colors.surface, borderRadius: radii.pill, padding: 4,
    borderWidth: 1, borderColor: colors.border,
  },
  segBtn: { flex: 1, paddingVertical: 10, paddingHorizontal: 8, alignItems: 'center', borderRadius: radii.pill },
  segBtnActive: { backgroundColor: colors.primary },
  segText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, flexShrink: 1 },
  segTextActive: { color: '#fff' },

  // ---- Payment-method nudge ----
  payAlert: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface,
    marginHorizontal: 16, marginTop: 16,
    borderRadius: radii.lg, padding: 16,
    ...shadows.card,
  },
  payAlertTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '600' },
  payAlertSub: { color: colors.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 2 },

  // ---- Empty states ----
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 60 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginBottom: 8, textAlign: 'center' },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },

  // ---- Posted gig card ----
  jobSection: { marginHorizontal: 16, marginTop: 12 },
  jobCard: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    padding: 16, ...shadows.card,
  },
  jobCardTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  jobCardInfo: { flex: 1, marginRight: 8 },
  jobTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, marginBottom: 4, letterSpacing: -0.2 },
  jobMeta: { fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
    maxWidth: '100%',
    borderRadius: radii.pill, paddingHorizontal: 10, paddingVertical: 5,
    marginRight: 6, marginBottom: 4,
  },
  chipText: { fontSize: 12, fontWeight: '600', flexShrink: 1 },
  // 2x2 grid — four labeled actions won't fit legibly in one row (long
  // labels like "Duplicate" overflow at ~80px), so they wrap two-per-row.
  jobActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  removedNote: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.accentLight, borderRadius: radii.md, padding: 12,
  },
  removedNoteText: { fontSize: 12, fontWeight: '500', color: colors.accentDeep, lineHeight: 17, flex: 1 },
  editBtn: {
    flexBasis: '45%', flexGrow: 1, flexDirection: 'row', justifyContent: 'center',
    backgroundColor: colors.surface, borderRadius: radii.md,
    paddingVertical: 12, paddingHorizontal: 12, alignItems: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  editBtnDim: { opacity: 0.5 },
  editBtnText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
  deleteBtn: {
    flexBasis: '45%', flexGrow: 1, flexDirection: 'row', justifyContent: 'center',
    backgroundColor: colors.urgentLight, borderRadius: radii.md,
    paddingVertical: 12, paddingHorizontal: 12, alignItems: 'center',
  },
  deleteBtnText: { fontSize: 13, fontWeight: '600', color: colors.urgent, flexShrink: 1 },

  // ---- Applicant list ----
  bookingsList: { marginLeft: 12, marginTop: 8 },
  noApplicants: { paddingHorizontal: 8, paddingVertical: 12 },
  noApplicantsText: { fontSize: 13, color: colors.textMuted, lineHeight: 19 },
  sortRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginLeft: 8, marginBottom: 8 },
  sortLabel: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginRight: 8, flexShrink: 0 },
  sortChip: {
    alignSelf: 'flex-start',
    borderRadius: radii.pill, paddingHorizontal: 12, paddingVertical: 7,
    marginRight: 6, marginBottom: 4,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
  },
  sortChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  sortChipText: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  sortChipTextActive: { color: '#fff' },
  bookingRow: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    padding: 16, marginLeft: 8, marginBottom: 8,
    ...shadows.card,
  },
  pastCard: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    padding: 16, marginHorizontal: 16, marginTop: 12,
    ...shadows.card,
  },

  // ---- Earner block ----
  earnerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  earnerTap: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  earnerInfo: { flex: 1 },
  earnerName: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  ratingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  earnerRating: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  metaIcon: { marginRight: 6 },
  metaText: { fontSize: 12, color: colors.textSecondary, lineHeight: 17, flex: 1 },
  counterVal: { fontWeight: '700', color: colors.textPrimary },
  noteQuote: {
    marginBottom: 8, borderLeftWidth: 1, borderLeftColor: colors.border, paddingLeft: 12,
  },
  noteQuoteText: { fontSize: 12, color: colors.textSecondary, lineHeight: 18 },
  inProgressRow: { marginBottom: 8 },
  inlineRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  inProgressText: { fontSize: 12, fontWeight: '600', color: colors.success, flexShrink: 1 },
  doneFlags: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  doneFlag: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  doneFlagDone: { color: colors.success, fontWeight: '600' },

  // ---- Past card extras ----
  pastRatingRow: { borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 12 },
  pastStars: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  pastRatingText: { fontSize: 12, color: colors.textSecondary, fontWeight: '500', lineHeight: 17, flexShrink: 1 },
  rebookBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    borderRadius: radii.md, paddingVertical: 12, paddingHorizontal: 16, marginTop: 12,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  rebookBtnText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },

  // ---- Photo strip ----
  photoStrip: { marginTop: 8, marginBottom: 4 },
  photoStripLabel: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 8 },
  photoThumb: { width: 60, height: 60, borderRadius: radii.sm, marginRight: 8, backgroundColor: colors.divider },

  // ---- Booking actions ----
  actions: { marginTop: 4 },
  acceptBtn: {
    flexDirection: 'row', justifyContent: 'center',
    backgroundColor: colors.successLight, borderRadius: radii.md,
    paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', marginBottom: 8,
  },
  acceptText: { fontSize: 13, fontWeight: '700', color: colors.success, flexShrink: 1 },
  declineBtn: {
    flexDirection: 'row', justifyContent: 'center',
    backgroundColor: colors.urgentLight, borderRadius: radii.md,
    paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', marginBottom: 8,
  },
  declineText: { fontSize: 13, fontWeight: '700', color: colors.urgent, flexShrink: 1 },
  markDoneBtn: {
    flexDirection: 'row', justifyContent: 'center',
    backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', marginBottom: 8,
  },
  markDoneText: { fontSize: 13, fontWeight: '700', color: '#fff', flexShrink: 1 },
  waitingBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.accentLight, borderRadius: radii.md,
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8,
  },
  waitingText: { fontSize: 12, fontWeight: '500', color: colors.accentDeep, lineHeight: 17, flex: 1 },
  verifyBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 12, paddingHorizontal: 16, marginBottom: 8,
  },
  verifyText: { color: '#fff', fontSize: 13, fontWeight: '700', flexShrink: 1 },
  msgBtn: {
    flexDirection: 'row', justifyContent: 'center',
    borderRadius: radii.md, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center',
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  msgBtnText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
  changeBtn: {
    flexDirection: 'row', justifyContent: 'center',
    borderRadius: radii.md, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', marginTop: 8,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  changeBtnText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
  cancelLink: { paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', marginTop: 4 },
  cancelLinkText: { fontSize: 13, fontWeight: '600', color: colors.urgent },
  cancelLockedText: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: 8, textAlign: 'center' },

  // ---- Amendment status banners ----
  amendPendingBanner: { backgroundColor: colors.accentLight, borderRadius: radii.md, padding: 12, marginTop: 8 },
  amendPendingText: { fontSize: 12, fontWeight: '500', color: colors.accentDeep, lineHeight: 17 },
  amendAcceptedBanner: { backgroundColor: colors.successLight, borderRadius: radii.md, padding: 12, marginTop: 8 },
  amendAcceptedText: { fontSize: 12, fontWeight: '500', color: colors.success, lineHeight: 17 },
  amendDeclinedBanner: { backgroundColor: colors.urgentLight, borderRadius: radii.md, padding: 12, marginTop: 8 },
  amendDeclinedText: { fontSize: 12, fontWeight: '500', color: colors.urgent, lineHeight: 17 },

  // ---- Amendment modal ----
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  amendModal: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    paddingHorizontal: 20, paddingBottom: 40,
  },
  amendModalHandle: {
    width: 40, height: 4, borderRadius: radii.pill, backgroundColor: colors.border,
    alignSelf: 'center', marginTop: 12, marginBottom: 20,
  },
  amendModalTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  amendModalTitle: { fontSize: 18, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.2, flexShrink: 1 },
  amendModalSub: { fontSize: 14, color: colors.textSecondary, lineHeight: 20, marginBottom: 16 },
  amendInput: {
    backgroundColor: colors.background, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    padding: 14, fontSize: 15, color: colors.textPrimary,
    minHeight: 100, lineHeight: 21, marginBottom: 16,
  },
  amendSubmitBtn: {
    backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 16, paddingHorizontal: 20, alignItems: 'center',
  },
  amendSubmitBtnDisabled: { backgroundColor: colors.divider },
  amendSubmitText: { color: '#fff', fontSize: 15, fontWeight: '700', flexShrink: 1 },
  amendSubmitTextDisabled: { color: colors.textMuted },
});
