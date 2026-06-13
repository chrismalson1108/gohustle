import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, Alert, Modal, TextInput,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useStripe } from '@stripe/stripe-react-native';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import BookingStatusBadge from '../components/BookingStatusBadge';
import CompletionModal from '../components/CompletionModal';
import MessageSheet from '../components/MessageSheet';
import { colors, gradients, shadows } from '../theme';

const ACTIVE_STATUSES = new Set(['pending', 'confirmed', 'completed']);

export default function GigsScreen({ navigation }) {
  const {
    postedJobs, posterBookings,
    acceptBooking, declineBooking,
    markPosterDone, verifyAndRate, deleteJob,
    refreshJobs, refreshPosterBookings,
    proposeAmendment, createPaymentIntent,
  } = useJobs();
  const { showToast } = useUser();
  const haptic = useHaptic();
  const insets = useSafeAreaInsets();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const [expanded, setExpanded]         = useState({});
  const [loadingId, setLoadingId]       = useState(null);
  const [verifyTarget, setVerifyTarget] = useState(null);
  const [msgTarget, setMsgTarget]       = useState(null);
  const [refreshing, setRefreshing]     = useState(false);
  const [amendTarget, setAmendTarget]   = useState(null); // { bookingId, earnerName }
  const [amendNote, setAmendNote]       = useState('');

  // Refresh from DB every time this tab gains focus
  useFocusEffect(
    useCallback(() => {
      refreshJobs();
      refreshPosterBookings();
    }, [])
  );

  // Group bookings by jobId
  const bookingsByJob = posterBookings.reduce((acc, b) => {
    const id = b.jobId;
    if (!acc[id]) acc[id] = [];
    acc[id].push(b);
    return acc;
  }, {});

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshJobs(), refreshPosterBookings()]);
    setRefreshing(false);
  };

  const toggleExpand = (jobId) =>
    setExpanded(prev => ({ ...prev, [jobId]: !prev[jobId] }));

  const handleDelete = (job) => {
    const bookings = bookingsByJob[job.id] || [];
    const activeBookings = bookings.filter(b => b.status === 'pending' || b.status === 'confirmed');
    if (activeBookings.length > 0) {
      Alert.alert(
        'Cannot Delete',
        'This gig has active bookings. Decline all pending/confirmed bookings before deleting.',
      );
      return;
    }
    Alert.alert(
      'Delete Gig?',
      `"${job.title}" will be removed from Browse and no one can book it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: () => { haptic.medium(); deleteJob(job.id); },
        },
      ],
    );
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
    await verifyAndRate(verifyTarget.id, data);
    showToast({ icon: '⭐', title: 'Job Verified!', message: 'Rating submitted and job marked complete.' });
  };

  const handleProposeAmendment = async () => {
    if (!amendTarget || !amendNote.trim()) return;
    await proposeAmendment(amendTarget.bookingId, amendNote.trim());
    showToast({ icon: '📝', title: 'Change Proposed', message: `${amendTarget.earnerName} will be notified to approve or decline.` });
    setAmendTarget(null);
    setAmendNote('');
  };

  const pendingCount = posterBookings.filter(b => b.status === 'pending' || b.status === 'completed').length;

  return (
    <View style={styles.container}>
      <LinearGradient colors={gradients.primary} style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.headerTitle}>My Gigs 📋</Text>
            <Text style={styles.headerSub}>
              {postedJobs.length === 0
                ? 'Post your first gig to start hiring'
                : `${postedJobs.length} gig${postedJobs.length !== 1 ? 's' : ''} posted${pendingCount > 0 ? ` · ${pendingCount} need attention` : ''}`}
            </Text>
          </View>
        </View>
        <TouchableOpacity
          style={styles.postBtn}
          onPress={() => navigation.navigate('PostJob')}
          activeOpacity={0.85}
        >
          <Text style={styles.postBtnText}>＋ Post New Gig</Text>
        </TouchableOpacity>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {postedJobs.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📬</Text>
            <Text style={styles.emptyTitle}>No gigs posted yet</Text>
            <Text style={styles.emptyText}>Tap "Post New Gig" above to create your first listing.</Text>
          </View>
        )}

        {postedJobs.map(job => {
          const jobBookings = bookingsByJob[job.id] || [];
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
                    <Text style={styles.jobMeta}>
                      {job.payType === 'hourly' ? `$${job.pay}/hr` : `$${job.pay} flat`}
                      {'  ·  '}{job.location}
                    </Text>
                  </View>
                  <Text style={styles.chevron}>{isExpanded ? '▲' : '▼'}</Text>
                </View>

                {/* Booking summary chips */}
                <View style={styles.chipRow}>
                  {isOpen && jobBookings.length === 0 && (
                    <View style={[styles.chip, styles.chipLive]}>
                      <Text style={styles.chipText}>🟢 Live</Text>
                    </View>
                  )}
                  {pendingN > 0 && (
                    <View style={[styles.chip, styles.chipPending]}>
                      <Text style={styles.chipText}>⏳ {pendingN} Pending</Text>
                    </View>
                  )}
                  {confirmedN > 0 && (
                    <View style={[styles.chip, styles.chipConfirmed]}>
                      <Text style={styles.chipText}>✅ {confirmedN} In Progress</Text>
                    </View>
                  )}
                  {completedN > 0 && (
                    <View style={[styles.chip, styles.chipCompleted]}>
                      <Text style={styles.chipText}>🔄 {completedN} Needs Verify</Text>
                    </View>
                  )}
                </View>

                {/* Job actions */}
                <View style={styles.jobActions}>
                  <TouchableOpacity
                    style={styles.editBtn}
                    onPress={() => navigation.navigate('EditJob', { jobId: job.id })}
                  >
                    <Text style={styles.editBtnText}>✏️ Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.deleteBtn}
                    onPress={() => handleDelete(job)}
                  >
                    <Text style={styles.deleteBtnText}>🗑 Delete</Text>
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>

              {/* Expanded bookings */}
              {isExpanded && (
                <View style={styles.bookingsList}>
                  {jobBookings.length === 0 ? (
                    <View style={styles.noApplicants}>
                      <Text style={styles.noApplicantsText}>No applicants yet — your gig is live on Browse.</Text>
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
                        onVerify={() => setVerifyTarget(booking)}
                        onMessage={() => setMsgTarget({
                          bookingId: booking.id,
                          jobTitle: job.title,
                          otherPerson: {
                            name: booking.earner?.name || 'Earner',
                            avatarInitial: booking.earner?.avatarInitial || 'E',
                          },
                        })}
                        onRequestChange={booking.status === 'confirmed'
                          ? () => { setAmendTarget({ bookingId: booking.id, earnerName: booking.earner?.name || 'Earner' }); setAmendNote(''); }
                          : null
                        }
                      />
                    ))
                  )}
                </View>
              )}
            </View>
          );
        })}
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
            <Text style={styles.amendModalTitle}>📝 Propose a Change</Text>
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
              <Text style={styles.amendSubmitText}>Send to {amendTarget?.earnerName} →</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function BookingRow({ booking, jobTitle, loading, onAccept, onDecline, onMarkDone, onVerify, onMessage, onRequestChange }) {
  const earnerName = booking.earner?.name || 'Someone';
  const initial    = booking.earner?.avatarInitial || earnerName[0]?.toUpperCase() || '?';
  const status     = booking.status;

  return (
    <View style={styles.bookingRow}>
      {/* Earner info */}
      <View style={styles.earnerRow}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <View style={styles.earnerInfo}>
          <Text style={styles.earnerName}>{earnerName}</Text>
          {booking.earner?.rating ? (
            <Text style={styles.earnerRating}>⭐ {Number(booking.earner.rating).toFixed(1)}</Text>
          ) : null}
        </View>
        <BookingStatusBadge status={status} compact />
      </View>

      {booking.slotLabel && (
        <View style={styles.metaRow}>
          <Text style={styles.metaIcon}>📅</Text>
          <Text style={styles.metaText}>{booking.slotLabel}</Text>
        </View>
      )}
      {booking.counterOffer && (
        <View style={styles.metaRow}>
          <Text style={styles.metaIcon}>💬</Text>
          <Text style={styles.metaText}>
            Counter-offer: <Text style={styles.counterVal}>${booking.counterOffer}</Text>
          </Text>
        </View>
      )}

      {/* In-progress + done flags */}
      {status === 'confirmed' && (
        <View style={styles.inProgressRow}>
          <Text style={styles.inProgressText}>🟢 In Progress</Text>
          {(booking.earnerDone || booking.posterDone) && (
            <View style={styles.doneFlags}>
              <Text style={[styles.doneFlag, booking.earnerDone && styles.doneFlagDone]}>
                {booking.earnerDone ? '✅' : '⬜'} Earner done
              </Text>
              <Text style={[styles.doneFlag, booking.posterDone && styles.doneFlagDone]}>
                {booking.posterDone ? '✅' : '⬜'} You done
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Verified summary */}
      {status === 'verified' && (
        <View style={styles.verifiedRow}>
          <Text style={styles.verifiedText}>
            You rated {earnerName} {booking.earnerRating ? `${booking.earnerRating} ⭐` : ''}
          </Text>
          {booking.posterRating ? (
            <Text style={styles.verifiedText}>{earnerName} rated you {booking.posterRating} ⭐</Text>
          ) : null}
        </View>
      )}

      {/* Actions */}
      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 10 }} />
      ) : (
        <View style={styles.actions}>
          {status === 'pending' && (
            <>
              <TouchableOpacity style={styles.acceptBtn} onPress={onAccept}>
                <Text style={styles.acceptText}>✓ Accept</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.declineBtn} onPress={onDecline}>
                <Text style={styles.declineText}>✕ Decline</Text>
              </TouchableOpacity>
            </>
          )}
          {status === 'confirmed' && !booking.posterDone && (
            <TouchableOpacity style={styles.markDoneBtn} onPress={onMarkDone}>
              <Text style={styles.markDoneText}>✓ Mark Job Done</Text>
            </TouchableOpacity>
          )}
          {status === 'confirmed' && booking.posterDone && !booking.earnerDone && (
            <View style={styles.waitingBanner}>
              <Text style={styles.waitingText}>⏳ Waiting for earner to confirm…</Text>
            </View>
          )}
          {status === 'completed' && (
            <TouchableOpacity onPress={onVerify} activeOpacity={0.85}>
              <LinearGradient colors={gradients.earn} style={styles.verifyBtn}>
                <Text style={styles.verifyText}>⭐ Verify & Rate {earnerName}</Text>
              </LinearGradient>
            </TouchableOpacity>
          )}
          {ACTIVE_STATUSES.has(status) && (
            <TouchableOpacity style={styles.msgBtn} onPress={onMessage}>
              <Text style={styles.msgBtnText}>💬 Message {earnerName}</Text>
            </TouchableOpacity>
          )}
          {onRequestChange && booking.amendmentStatus === 'none' && (
            <TouchableOpacity style={styles.changeBtn} onPress={onRequestChange}>
              <Text style={styles.changeBtnText}>📝 Request Change</Text>
            </TouchableOpacity>
          )}
          {booking.amendmentStatus === 'pending' && (
            <View style={styles.amendPendingBanner}>
              <Text style={styles.amendPendingText}>⏳ Change proposed — waiting for {earnerName} to respond</Text>
            </View>
          )}
          {booking.amendmentStatus === 'accepted' && (
            <View style={styles.amendAcceptedBanner}>
              <Text style={styles.amendAcceptedText}>✅ Change accepted — edit your gig in the Edit screen</Text>
            </View>
          )}
          {booking.amendmentStatus === 'declined' && (
            <View style={styles.amendDeclinedBanner}>
              <Text style={styles.amendDeclinedText}>❌ Change declined — original terms remain</Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: 20, paddingBottom: 20 },
  headerRow: { marginBottom: 16 },
  headerTitle: { fontSize: 24, fontWeight: '900', color: '#fff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.8)' },
  postBtn: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 14, paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.4)',
  },
  postBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 60 },
  emptyIcon: { fontSize: 52, marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: colors.textPrimary, marginBottom: 8 },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  jobSection: { marginHorizontal: 16, marginTop: 16 },
  jobCard: {
    backgroundColor: colors.surface, borderRadius: 18,
    padding: 16, borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  jobCardTop: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
  jobCardInfo: { flex: 1 },
  jobTitle: { fontSize: 16, fontWeight: '800', color: colors.textPrimary, marginBottom: 3 },
  jobMeta: { fontSize: 12, color: colors.textMuted },
  chevron: { fontSize: 12, color: colors.textMuted, marginLeft: 8, marginTop: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 10 },
  chip: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4, marginRight: 6, marginBottom: 4 },
  chipText: { fontSize: 11, fontWeight: '700' },
  chipLive:      { backgroundColor: '#ECFDF5' },
  chipPending:   { backgroundColor: '#FFF7ED' },
  chipConfirmed: { backgroundColor: '#EEF2FF' },
  chipCompleted: { backgroundColor: '#FEF3C7' },
  jobActions: { flexDirection: 'row' },
  editBtn: {
    flex: 1, backgroundColor: colors.primaryLight, borderRadius: 10,
    paddingVertical: 9, alignItems: 'center', marginRight: 8,
    borderWidth: 1, borderColor: colors.primary + '40',
  },
  editBtnText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  deleteBtn: {
    flex: 1, backgroundColor: '#FEF2F2', borderRadius: 10,
    paddingVertical: 9, alignItems: 'center',
    borderWidth: 1, borderColor: '#FECACA',
  },
  deleteBtnText: { fontSize: 13, fontWeight: '700', color: colors.urgent },
  bookingsList: {
    borderLeftWidth: 2, borderLeftColor: colors.primary + '30',
    marginLeft: 12, marginTop: 4,
  },
  noApplicants: { padding: 16 },
  noApplicantsText: { fontSize: 13, color: colors.textMuted, fontStyle: 'italic' },
  bookingRow: {
    backgroundColor: colors.surface, borderRadius: 14,
    padding: 14, marginLeft: 8, marginBottom: 8,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  earnerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  avatar: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', marginRight: 10,
  },
  avatarText: { color: '#fff', fontWeight: '900', fontSize: 15 },
  earnerInfo: { flex: 1 },
  earnerName: { fontSize: 14, fontWeight: '800', color: colors.textPrimary },
  earnerRating: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  metaIcon: { fontSize: 11, marginRight: 5 },
  metaText: { fontSize: 12, color: colors.textSecondary },
  counterVal: { fontWeight: '800', color: colors.primary },
  inProgressRow: { marginBottom: 8 },
  inProgressText: { fontSize: 12, fontWeight: '700', color: colors.success },
  doneFlags: { flexDirection: 'row', marginTop: 4 },
  doneFlag: { fontSize: 11, color: colors.textMuted, marginRight: 12 },
  doneFlagDone: { color: colors.success, fontWeight: '700' },
  verifiedRow: { backgroundColor: colors.accentLight, borderRadius: 8, padding: 8, marginBottom: 8 },
  verifiedText: { fontSize: 12, fontWeight: '700', color: colors.success },
  actions: { marginTop: 4 },
  acceptBtn: {
    backgroundColor: colors.accentLight, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center', marginBottom: 6,
  },
  acceptText: { fontSize: 13, fontWeight: '800', color: colors.success },
  declineBtn: {
    backgroundColor: '#FEE2E2', borderRadius: 10,
    paddingVertical: 10, alignItems: 'center', marginBottom: 6,
  },
  declineText: { fontSize: 13, fontWeight: '800', color: colors.urgent },
  markDoneBtn: {
    backgroundColor: colors.primaryLight, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center', marginBottom: 6,
    borderWidth: 1.5, borderColor: colors.primary,
  },
  markDoneText: { fontSize: 13, fontWeight: '800', color: colors.primary },
  waitingBanner: {
    backgroundColor: '#FFF7ED', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 7, marginBottom: 6,
  },
  waitingText: { fontSize: 12, fontWeight: '600', color: '#D97706' },
  verifyBtn: { borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginBottom: 6 },
  verifyText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  msgBtn: {
    borderRadius: 10, paddingVertical: 9, alignItems: 'center',
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface,
  },
  msgBtnText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  changeBtn: {
    borderRadius: 10, paddingVertical: 9, alignItems: 'center', marginTop: 6,
    borderWidth: 1.5, borderColor: colors.primary + '60', backgroundColor: colors.primaryLight,
  },
  changeBtnText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  amendPendingBanner: { backgroundColor: '#FFF7ED', borderRadius: 8, padding: 9, marginTop: 6 },
  amendPendingText: { fontSize: 12, fontWeight: '600', color: '#D97706' },
  amendAcceptedBanner: { backgroundColor: '#ECFDF5', borderRadius: 8, padding: 9, marginTop: 6 },
  amendAcceptedText: { fontSize: 12, fontWeight: '600', color: '#059669' },
  amendDeclinedBanner: { backgroundColor: '#FEF2F2', borderRadius: 8, padding: 9, marginTop: 6 },
  amendDeclinedText: { fontSize: 12, fontWeight: '600', color: '#DC2626' },
  // Amendment modal
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  amendModal: {
    backgroundColor: '#fff', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: 20, paddingBottom: 40,
  },
  amendModalHandle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border,
    alignSelf: 'center', marginTop: 12, marginBottom: 20,
  },
  amendModalTitle: { fontSize: 18, fontWeight: '900', color: colors.textPrimary, marginBottom: 6 },
  amendModalSub: { fontSize: 13, color: colors.textSecondary, lineHeight: 19, marginBottom: 16 },
  amendInput: {
    backgroundColor: colors.background, borderRadius: 14,
    borderWidth: 1.5, borderColor: colors.border,
    padding: 14, fontSize: 14, color: colors.textPrimary,
    minHeight: 100, lineHeight: 21, marginBottom: 16,
  },
  amendSubmitBtn: {
    backgroundColor: colors.primary, borderRadius: 14,
    paddingVertical: 15, alignItems: 'center',
  },
  amendSubmitBtnDisabled: { backgroundColor: colors.border },
  amendSubmitText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
