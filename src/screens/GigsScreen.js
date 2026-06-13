import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Image,
  ActivityIndicator, RefreshControl, Alert, Modal, TextInput,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useStripe } from '@stripe/stripe-react-native';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import BookingStatusBadge from '../components/BookingStatusBadge';
import CompletionModal from '../components/CompletionModal';
import MessageSheet from '../components/MessageSheet';
import Avatar from '../components/Avatar';
import { colors, gradients, shadows } from '../theme';

const ACTIVE_STATUSES  = new Set(['pending', 'confirmed', 'completed']);
const PAST_STATUSES    = new Set(['verified', 'declined']);

export default function GigsScreen({ navigation }) {
  const {
    postedJobs, posterBookings,
    acceptBooking, declineBooking,
    markPosterDone, verifyAndRate, deleteJob,
    refreshJobs, refreshPosterBookings,
    proposeAmendment, createPaymentIntent, getPaymentMethodStatus,
  } = useJobs();
  const { showToast } = useUser();
  const haptic = useHaptic();
  const insets = useSafeAreaInsets();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const [tab, setTab]                   = useState('active'); // 'active' | 'past'
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
          <View style={styles.headerTitleRow}>
            <Ionicons name="megaphone" size={22} color="#fff" style={{ marginRight: 8 }} />
            <Text style={styles.headerTitle}>Hiring</Text>
          </View>
          <Text style={styles.headerSub}>
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
          <Text style={styles.postBtnText}>Post New Gig</Text>
        </TouchableOpacity>
      </LinearGradient>

      {/* Segmented control */}
      <View style={styles.segment}>
        <SegmentBtn label="Active" count={postedJobs.length}   active={tab === 'active'} onPress={() => { haptic.selection(); setTab('active'); }} />
        <SegmentBtn label="Past"   count={pastBookings.length} active={tab === 'past'}   onPress={() => { haptic.selection(); setTab('past'); }} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {!hasCard && (
          <TouchableOpacity
            style={styles.payAlert}
            onPress={() => { haptic.medium(); navigation.navigate('ProfileTab', { screen: 'PayoutSetup', initial: false }); }}
            activeOpacity={0.85}
          >
            <Ionicons name="card" size={18} color="#fff" />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={styles.payAlertTitle}>Add a payment method to hire</Text>
              <Text style={styles.payAlertSub}>Save a card so you can accept bookings →</Text>
            </View>
          </TouchableOpacity>
        )}

        {/* ===== ACTIVE: posted listings + current bookings ===== */}
        {tab === 'active' && postedJobs.length === 0 && (
          <View style={styles.empty}>
            <Ionicons name="briefcase-outline" size={52} color={colors.textMuted} style={{ marginBottom: 16 }} />
            <Text style={styles.emptyTitle}>No gigs posted yet</Text>
            <Text style={styles.emptyText}>Tap "Post New Gig" above to create your first listing.</Text>
          </View>
        )}

        {tab === 'active' && postedJobs.map(job => {
          const allBookings = bookingsByJob[job.id] || [];
          const jobBookings = allBookings.filter(b => ACTIVE_STATUSES.has(b.status));
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
                  <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} style={{ marginLeft: 8, marginTop: 2 }} />
                </View>

                {/* Booking summary chips */}
                <View style={styles.chipRow}>
                  {isOpen && jobBookings.length === 0 && (
                    <Chip ion="ellipse" color="#059669" bg="#ECFDF5" label="Live" />
                  )}
                  {pendingN > 0 && (
                    <Chip ion="time" color="#D97706" bg="#FFF7ED" label={`${pendingN} Pending`} />
                  )}
                  {confirmedN > 0 && (
                    <Chip ion="checkmark-circle" color="#4F46E5" bg="#EEF2FF" label={`${confirmedN} In Progress`} />
                  )}
                  {completedN > 0 && (
                    <Chip ion="sync" color="#B45309" bg="#FEF3C7" label={`${completedN} Needs Verify`} />
                  )}
                </View>

                {/* Job actions */}
                <View style={styles.jobActions}>
                  <TouchableOpacity
                    style={styles.editBtn}
                    onPress={() => navigation.navigate('EditJob', { jobId: job.id })}
                  >
                    <Ionicons name="create-outline" size={15} color={colors.primary} style={{ marginRight: 5 }} />
                    <Text style={styles.editBtnText}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.deleteBtn}
                    onPress={() => handleDelete(job)}
                  >
                    <Ionicons name="trash-outline" size={15} color={colors.urgent} style={{ marginRight: 5 }} />
                    <Text style={styles.deleteBtnText}>Delete</Text>
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>

              {/* Expanded bookings */}
              {isExpanded && (
                <View style={styles.bookingsList}>
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
                        onVerify={() => setVerifyTarget(booking)}
                        onMessage={() => setMsgTarget({
                          bookingId: booking.id,
                          jobTitle: job.title,
                          otherPerson: {
                            name: booking.earner?.name || 'Earner',
                            avatarInitial: booking.earner?.avatarInitial || 'E',
                            avatarUrl: booking.earner?.avatarUrl,
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

        {/* ===== PAST: completed / declined history ===== */}
        {tab === 'past' && pastBookings.length === 0 && (
          <View style={styles.empty}>
            <Ionicons name="time-outline" size={52} color={colors.textMuted} style={{ marginBottom: 16 }} />
            <Text style={styles.emptyTitle}>No past gigs yet</Text>
            <Text style={styles.emptyText}>Completed and declined bookings will show up here.</Text>
          </View>
        )}

        {tab === 'past' && pastBookings.map(booking => (
          <PastBookingCard key={booking.id} booking={booking} />
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
              <Text style={styles.amendModalTitle}>Propose a Change</Text>
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
              <Text style={styles.amendSubmitText}>Send to {amendTarget?.earnerName} →</Text>
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
      <Text style={[styles.segText, active && styles.segTextActive]}>
        {label}{count > 0 ? ` (${count})` : ''}
      </Text>
    </TouchableOpacity>
  );
}

function CompletionStrip({ photos }) {
  if (!photos?.length) return null;
  return (
    <View style={styles.photoStrip}>
      <Text style={styles.photoStripLabel}>Completion photos</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {photos.map((u, i) => (
          <Image key={i} source={{ uri: u }} style={styles.photoThumb} />
        ))}
      </ScrollView>
    </View>
  );
}

function Chip({ ion, color, bg, label }) {
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <Ionicons name={ion} size={11} color={color} style={{ marginRight: 4 }} />
      <Text style={[styles.chipText, { color }]}>{label}</Text>
    </View>
  );
}

function PastBookingCard({ booking }) {
  const earnerName = booking.earner?.name || 'Someone';
  const initial    = booking.earner?.avatarInitial || earnerName[0]?.toUpperCase() || '?';
  const declined   = booking.status === 'declined';

  return (
    <View style={styles.pastCard}>
      <View style={styles.earnerRow}>
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
          <Text style={styles.earnerName}>{earnerName}</Text>
        </View>
        <BookingStatusBadge status={booking.status} compact />
      </View>
      {!declined && (
        <View style={styles.pastRatingRow}>
          {booking.earnerRating ? (
            <View style={styles.pastStars}>
              {[1,2,3,4,5].map(s => (
                <Ionicons key={s} name={s <= Math.round(booking.earnerRating) ? 'star' : 'star-outline'} size={13} color={colors.gold} style={{ marginRight: 1 }} />
              ))}
              <Text style={styles.pastRatingText}>  You rated {earnerName} {Number(booking.earnerRating).toFixed(1)}</Text>
            </View>
          ) : (
            <Text style={styles.pastRatingText}>Completed</Text>
          )}
          {booking.posterRating ? (
            <Text style={styles.pastRatingText}>{earnerName} rated you {booking.posterRating} ★</Text>
          ) : null}
        </View>
      )}
      <CompletionStrip photos={booking.completionPhotos} />
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
        <Avatar url={booking.earner?.avatarUrl} initial={initial} size={38} fontSize={15} style={{ marginRight: 10 }} />
        <View style={styles.earnerInfo}>
          <Text style={styles.earnerName}>{earnerName}</Text>
          {booking.earner?.rating ? (
            <View style={styles.ratingRow}>
              <Ionicons name="star" size={11} color={colors.gold} style={{ marginRight: 3 }} />
              <Text style={styles.earnerRating}>{Number(booking.earner.rating).toFixed(1)}</Text>
            </View>
          ) : null}
        </View>
        <BookingStatusBadge status={status} compact />
      </View>

      {booking.slotLabel && (
        <View style={styles.metaRow}>
          <Ionicons name="calendar-outline" size={12} color={colors.textMuted} style={styles.metaIcon} />
          <Text style={styles.metaText}>{booking.slotLabel}</Text>
        </View>
      )}
      {booking.counterOffer && (
        <View style={styles.metaRow}>
          <Ionicons name="chatbubble-outline" size={12} color={colors.textMuted} style={styles.metaIcon} />
          <Text style={styles.metaText}>
            Counter-offer: <Text style={styles.counterVal}>${booking.counterOffer}</Text>
          </Text>
        </View>
      )}

      {/* In-progress + done flags */}
      {status === 'confirmed' && (
        <View style={styles.inProgressRow}>
          <View style={styles.inlineRow}>
            <Ionicons name="ellipse" size={9} color={colors.success} style={{ marginRight: 5 }} />
            <Text style={styles.inProgressText}>In Progress</Text>
          </View>
          {(booking.earnerDone || booking.posterDone) && (
            <View style={styles.doneFlags}>
              <View style={styles.inlineRow}>
                <Ionicons name={booking.earnerDone ? 'checkbox' : 'square-outline'} size={13} color={booking.earnerDone ? colors.success : colors.textMuted} style={{ marginRight: 4 }} />
                <Text style={[styles.doneFlag, booking.earnerDone && styles.doneFlagDone]}>Earner done</Text>
              </View>
              <View style={[styles.inlineRow, { marginLeft: 12 }]}>
                <Ionicons name={booking.posterDone ? 'checkbox' : 'square-outline'} size={13} color={booking.posterDone ? colors.success : colors.textMuted} style={{ marginRight: 4 }} />
                <Text style={[styles.doneFlag, booking.posterDone && styles.doneFlagDone]}>You done</Text>
              </View>
            </View>
          )}
        </View>
      )}

      <CompletionStrip photos={booking.completionPhotos} />

      {/* Actions */}
      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 10 }} />
      ) : (
        <View style={styles.actions}>
          {status === 'pending' && (
            <>
              <TouchableOpacity style={styles.acceptBtn} onPress={onAccept}>
                <Ionicons name="checkmark" size={15} color={colors.success} style={{ marginRight: 5 }} />
                <Text style={styles.acceptText}>Accept</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.declineBtn} onPress={onDecline}>
                <Ionicons name="close" size={15} color={colors.urgent} style={{ marginRight: 5 }} />
                <Text style={styles.declineText}>Decline</Text>
              </TouchableOpacity>
            </>
          )}
          {status === 'confirmed' && !booking.posterDone && (
            <TouchableOpacity style={styles.markDoneBtn} onPress={onMarkDone}>
              <Ionicons name="checkmark-done" size={15} color={colors.primary} style={{ marginRight: 5 }} />
              <Text style={styles.markDoneText}>Mark Job Done</Text>
            </TouchableOpacity>
          )}
          {status === 'confirmed' && booking.posterDone && !booking.earnerDone && (
            <View style={styles.waitingBanner}>
              <Ionicons name="hourglass-outline" size={13} color="#D97706" style={{ marginRight: 5 }} />
              <Text style={styles.waitingText}>Waiting for earner to confirm…</Text>
            </View>
          )}
          {status === 'completed' && (
            <TouchableOpacity onPress={onVerify} activeOpacity={0.85}>
              <LinearGradient colors={gradients.earn} style={styles.verifyBtn}>
                <Ionicons name="star" size={15} color="#fff" style={{ marginRight: 6 }} />
                <Text style={styles.verifyText}>Verify & Rate {earnerName}</Text>
              </LinearGradient>
            </TouchableOpacity>
          )}
          {ACTIVE_STATUSES.has(status) && (
            <TouchableOpacity style={styles.msgBtn} onPress={onMessage}>
              <Ionicons name="chatbubble-ellipses-outline" size={15} color={colors.textSecondary} style={{ marginRight: 6 }} />
              <Text style={styles.msgBtnText}>Message {earnerName}</Text>
            </TouchableOpacity>
          )}
          {onRequestChange && booking.amendmentStatus === 'none' && (
            <TouchableOpacity style={styles.changeBtn} onPress={onRequestChange}>
              <Ionicons name="document-text-outline" size={15} color={colors.primary} style={{ marginRight: 6 }} />
              <Text style={styles.changeBtnText}>Request Change</Text>
            </TouchableOpacity>
          )}
          {booking.amendmentStatus === 'pending' && (
            <View style={styles.amendPendingBanner}>
              <Text style={styles.amendPendingText}>Change proposed — waiting for {earnerName} to respond</Text>
            </View>
          )}
          {booking.amendmentStatus === 'accepted' && (
            <View style={styles.amendAcceptedBanner}>
              <Text style={styles.amendAcceptedText}>Change accepted — edit your gig in the Edit screen</Text>
            </View>
          )}
          {booking.amendmentStatus === 'declined' && (
            <View style={styles.amendDeclinedBanner}>
              <Text style={styles.amendDeclinedText}>Change declined — original terms remain</Text>
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
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  headerTitle: { fontSize: 24, fontWeight: '900', color: '#fff' },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.8)' },
  postBtn: {
    flexDirection: 'row', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 14, paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.4)',
  },
  postBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  segment: {
    flexDirection: 'row', marginHorizontal: 16, marginTop: 16,
    backgroundColor: colors.surface, borderRadius: 14, padding: 4,
    borderWidth: 1, borderColor: colors.border,
  },
  segBtn: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: 10 },
  segBtnActive: { backgroundColor: colors.primary },
  segText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  segTextActive: { color: '#fff' },
  payAlert: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#7C3AED',
    marginHorizontal: 16, marginTop: 14,
    borderRadius: 14, padding: 14,
    ...shadows.sm,
  },
  payAlertTitle: { color: '#fff', fontSize: 13.5, fontWeight: '800' },
  payAlertSub: { color: 'rgba(255,255,255,0.78)', fontSize: 12, marginTop: 1 },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 60 },
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4, marginRight: 6, marginBottom: 4 },
  chipText: { fontSize: 11, fontWeight: '700' },
  jobActions: { flexDirection: 'row' },
  editBtn: {
    flex: 1, flexDirection: 'row', justifyContent: 'center',
    backgroundColor: colors.primaryLight, borderRadius: 10,
    paddingVertical: 9, alignItems: 'center', marginRight: 8,
    borderWidth: 1, borderColor: colors.primary + '40',
  },
  editBtnText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  deleteBtn: {
    flex: 1, flexDirection: 'row', justifyContent: 'center',
    backgroundColor: '#FEF2F2', borderRadius: 10,
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
  pastCard: {
    backgroundColor: colors.surface, borderRadius: 14,
    padding: 14, marginHorizontal: 16, marginTop: 12,
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
  ratingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 1 },
  earnerRating: { fontSize: 11, color: colors.textMuted },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  metaIcon: { marginRight: 5 },
  metaText: { fontSize: 12, color: colors.textSecondary },
  counterVal: { fontWeight: '800', color: colors.primary },
  inProgressRow: { marginBottom: 8 },
  inlineRow: { flexDirection: 'row', alignItems: 'center' },
  inProgressText: { fontSize: 12, fontWeight: '700', color: colors.success },
  doneFlags: { flexDirection: 'row', marginTop: 4 },
  doneFlag: { fontSize: 11, color: colors.textMuted },
  doneFlagDone: { color: colors.success, fontWeight: '700' },
  pastRatingRow: { borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 10 },
  pastStars: { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
  pastRatingText: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  photoStrip: { marginTop: 8, marginBottom: 4 },
  photoStripLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 },
  photoThumb: { width: 60, height: 60, borderRadius: 10, marginRight: 8, backgroundColor: colors.border },
  actions: { marginTop: 4 },
  acceptBtn: {
    flexDirection: 'row', justifyContent: 'center',
    backgroundColor: colors.accentLight, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center', marginBottom: 6,
  },
  acceptText: { fontSize: 13, fontWeight: '800', color: colors.success },
  declineBtn: {
    flexDirection: 'row', justifyContent: 'center',
    backgroundColor: '#FEE2E2', borderRadius: 10,
    paddingVertical: 10, alignItems: 'center', marginBottom: 6,
  },
  declineText: { fontSize: 13, fontWeight: '800', color: colors.urgent },
  markDoneBtn: {
    flexDirection: 'row', justifyContent: 'center',
    backgroundColor: colors.primaryLight, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center', marginBottom: 6,
    borderWidth: 1.5, borderColor: colors.primary,
  },
  markDoneText: { fontSize: 13, fontWeight: '800', color: colors.primary },
  waitingBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#FFF7ED', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 7, marginBottom: 6,
  },
  waitingText: { fontSize: 12, fontWeight: '600', color: '#D97706' },
  verifyBtn: { flexDirection: 'row', justifyContent: 'center', borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginBottom: 6 },
  verifyText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  msgBtn: {
    flexDirection: 'row', justifyContent: 'center',
    borderRadius: 10, paddingVertical: 9, alignItems: 'center',
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface,
  },
  msgBtnText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  changeBtn: {
    flexDirection: 'row', justifyContent: 'center',
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
  amendModalTitleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  amendModalTitle: { fontSize: 18, fontWeight: '900', color: colors.textPrimary },
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
