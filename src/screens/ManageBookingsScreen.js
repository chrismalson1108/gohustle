import React, { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import BookingStatusBadge from '../components/BookingStatusBadge';
import CompletionModal from '../components/CompletionModal';
import MessageSheet from '../components/MessageSheet';
import { colors, gradients, shadows } from '../theme';

const SECTION_ORDER  = ['pending', 'completed', 'confirmed', 'verified', 'declined'];
const SECTION_TITLES = {
  pending:   '⏳ Action Needed — New Requests',
  completed: '🔄 Both Marked Done — Verify Now',
  confirmed: '✅ Confirmed — In Progress',
  verified:  '💚 Completed',
  declined:  '❌ Declined',
};
const ACTIVE_STATUSES = new Set(['pending', 'confirmed', 'completed']);

export default function ManageBookingsScreen() {
  const { posterBookings, declineBooking, verifyAndRate, markPosterDone, refreshPosterBookings } = useJobs();
  const { showToast } = useUser();
  const navigation = useNavigation();
  const haptic = useHaptic();
  const insets = useSafeAreaInsets();
  const [verifyTarget, setVerifyTarget] = useState(null);
  const [msgTarget, setMsgTarget]       = useState(null);
  const [loadingId, setLoadingId]       = useState(null);
  const [refreshing, setRefreshing]     = useState(false);

  const grouped = SECTION_ORDER.reduce((acc, status) => {
    const items = posterBookings.filter(b => b.status === status);
    if (items.length) acc[status] = items;
    return acc;
  }, {});

  const onRefresh = async () => {
    setRefreshing(true);
    await refreshPosterBookings();
    setRefreshing(false);
  };

  const handleAccept = async () => {
    // Accepting requires authorizing the escrow card hold, which lives in the Hiring
    // tab's accept flow (GigsScreen → AcceptPaymentModal). This legacy screen has no
    // payment step, so route the poster there instead of attempting a confirm that
    // the server would reject for having no funded hold.
    haptic.selection();
    showToast({ icon: '💳', title: 'Accept from Hiring', message: 'Open the gig in the Hiring tab to authorize payment and accept.' });
    navigation.navigate('GigsTab');
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
  };

  const handleVerify = async (data) => {
    if (!verifyTarget) return;
    await verifyAndRate(verifyTarget.id, data);
  };

  const isEmpty = Object.keys(grouped).length === 0;

  return (
    <View style={styles.container}>
      <LinearGradient colors={gradients.profile} style={[styles.header, { paddingTop: insets.top + 16 }]}>
        <Text style={styles.headerTitle}>Manage Bookings</Text>
        <Text style={styles.headerSub}>
          {posterBookings.length === 0
            ? 'No bookings yet on your gigs'
            : `${posterBookings.length} booking${posterBookings.length !== 1 ? 's' : ''} across your gigs`}
        </Text>
      </LinearGradient>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {isEmpty && (
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📬</Text>
            <Text style={styles.emptyTitle}>No bookings yet</Text>
            <Text style={styles.emptyText}>When students book your gigs they'll appear here for you to accept or decline.</Text>
          </View>
        )}

        {SECTION_ORDER.map(status => {
          const items = grouped[status];
          if (!items) return null;
          return (
            <View key={status} style={styles.section}>
              <Text style={styles.sectionTitle}>{SECTION_TITLES[status]}</Text>
              {items.map(booking => (
                <BookingItem
                  key={booking.id}
                  booking={booking}
                  loading={loadingId === booking.id}
                  onAccept={() => handleAccept(booking.id)}
                  onDecline={() => handleDecline(booking.id)}
                  onMarkDone={() => handleMarkDone(booking)}
                  onVerify={() => setVerifyTarget(booking)}
                  onMessage={() => setMsgTarget({
                    bookingId: booking.id,
                    jobTitle: booking.job?.title || 'Your Gig',
                    otherPerson: {
                      name: booking.earner?.name || 'Earner',
                      avatarInitial: booking.earner?.avatarInitial || 'E',
                    },
                  })}
                />
              ))}
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
    </View>
  );
}

function BookingItem({ booking, loading, onAccept, onDecline, onMarkDone, onVerify, onMessage }) {
  const earnerName = booking.earner?.name || 'Someone';
  const initial    = booking.earner?.avatarInitial || earnerName[0]?.toUpperCase() || '?';
  const rating     = booking.earner?.rating;
  const jobTitle   = booking.job?.title || 'Unknown Gig';
  const pay        = booking.job?.pay;
  const payType    = booking.job?.payType;
  const status     = booking.status;

  return (
    <View style={styles.card}>
      {/* Earner row */}
      <View style={styles.earnerRow}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <View style={styles.earnerInfo}>
          <Text style={styles.earnerName}>{earnerName}</Text>
          {rating ? <Text style={styles.earnerRating}>⭐ {Number(rating).toFixed(1)}</Text> : null}
        </View>
        <BookingStatusBadge status={status} compact />
      </View>

      {/* Job info */}
      <View style={styles.jobRow}>
        <Text style={styles.jobTitle}>{jobTitle}</Text>
        {pay ? (
          <Text style={styles.jobPay}>{payType === 'hourly' ? `$${pay}/hr` : `$${pay} flat`}</Text>
        ) : null}
      </View>

      {booking.slotLabel && (
        <View style={styles.infoRow}>
          <Text style={styles.infoIcon}>📅</Text>
          <Text style={styles.infoText}>{booking.slotLabel}</Text>
        </View>
      )}
      {booking.counterOffer && (
        <View style={styles.infoRow}>
          <Text style={styles.infoIcon}>💬</Text>
          <Text style={styles.infoText}>
            Counter-offer: <Text style={styles.counterValue}>
              ${booking.counterOffer}{payType === 'hourly' ? '/hr' : ' flat'}
            </Text>
            {' '}(listed ${pay})
          </Text>
        </View>
      )}

      {/* In-progress banner */}
      {status === 'confirmed' && (
        <View style={styles.inProgressBanner}>
          <Text style={styles.inProgressText}>🟢 In Progress</Text>
        </View>
      )}

      {/* Done-flag indicators */}
      {status === 'confirmed' && (booking.earnerDone || booking.posterDone) && (
        <View style={styles.doneFlags}>
          <Text style={[styles.doneFlagItem, booking.earnerDone && styles.doneFlagDone]}>
            {booking.earnerDone ? '✅' : '⬜'} Earner confirmed done
          </Text>
          <Text style={[styles.doneFlagItem, booking.posterDone && styles.doneFlagDone]}>
            {booking.posterDone ? '✅' : '⬜'} You confirmed done
          </Text>
        </View>
      )}

      {/* Waiting banner — poster marked done but earner hasn't */}
      {status === 'confirmed' && booking.posterDone && !booking.earnerDone && (
        <View style={styles.waitingBanner}>
          <Text style={styles.waitingText}>⏳ Waiting for earner to confirm…</Text>
        </View>
      )}

      {/* Verified result */}
      {status === 'verified' && booking.earnerRating && (
        <View style={styles.verifiedRow}>
          <Text style={styles.verifiedText}>
            You rated {earnerName} {'⭐'.repeat(Math.round(booking.earnerRating))}
          </Text>
          {booking.paymentMethod && (
            <Text style={styles.paymentText}>
              Paid via {booking.paymentMethod.charAt(0).toUpperCase() + booking.paymentMethod.slice(1)}
            </Text>
          )}
        </View>
      )}
      {status === 'verified' && booking.posterRating && (
        <View style={[styles.verifiedRow, { marginTop: 6 }]}>
          <Text style={styles.verifiedText}>
            {earnerName} rated you {booking.posterRating} ⭐
          </Text>
          {booking.posterReview ? (
            <Text style={styles.reviewQuote}>"{booking.posterReview}"</Text>
          ) : null}
        </View>
      )}

      {/* Actions */}
      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 12 }} />
      ) : (
        <>
          {status === 'pending' && (
            <View style={styles.actionRow}>
              <TouchableOpacity style={styles.acceptBtn} onPress={onAccept}>
                <Text style={styles.acceptText}>✓ Accept</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.declineBtn} onPress={onDecline}>
                <Text style={styles.declineText}>✕ Decline</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Mark Done — poster side, when confirmed and poster hasn't marked yet */}
          {status === 'confirmed' && !booking.posterDone && (
            <TouchableOpacity style={styles.markDoneBtn} onPress={onMarkDone}>
              <Text style={styles.markDoneText}>✓ Mark Job Done</Text>
            </TouchableOpacity>
          )}

          {/* Verify & Rate — when both marked done (completed) */}
          {status === 'completed' && (
            <TouchableOpacity onPress={onVerify} activeOpacity={0.85}>
              <LinearGradient colors={gradients.earn} style={styles.verifyBtn}>
                <Text style={styles.verifyText}>⭐ Verify & Rate {earnerName}</Text>
              </LinearGradient>
            </TouchableOpacity>
          )}

          {/* Message — all active statuses */}
          {ACTIVE_STATUSES.has(status) && (
            <TouchableOpacity style={styles.msgBtn} onPress={onMessage}>
              <Text style={styles.msgBtnText}>💬 Message {earnerName}</Text>
            </TouchableOpacity>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: 20, paddingBottom: 24 },
  headerTitle: { fontSize: 24, fontWeight: '900', color: '#fff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.75)' },
  scroll: { flex: 1 },
  section: { paddingHorizontal: 16, marginTop: 24 },
  sectionTitle: {
    fontSize: 12, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10,
  },
  card: {
    backgroundColor: colors.surface, borderRadius: 18,
    padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  earnerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  avatar: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: { color: '#fff', fontWeight: '900', fontSize: 17 },
  earnerInfo: { flex: 1 },
  earnerName: { fontSize: 15, fontWeight: '800', color: colors.textPrimary },
  earnerRating: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  jobRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  jobTitle: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, flex: 1 },
  jobPay: { fontSize: 14, fontWeight: '800', color: colors.success, marginLeft: 8 },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 4 },
  infoIcon: { fontSize: 12, marginRight: 6, marginTop: 1 },
  infoText: { fontSize: 12, color: colors.textSecondary, flex: 1, lineHeight: 18 },
  counterValue: { fontWeight: '800', color: colors.primary },
  inProgressBanner: {
    backgroundColor: '#ECFDF5', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6, marginTop: 8, alignSelf: 'flex-start',
  },
  inProgressText: { fontSize: 12, fontWeight: '700', color: colors.success },
  doneFlags: { marginTop: 8 },
  doneFlagItem: { fontSize: 12, color: colors.textMuted, marginBottom: 3 },
  doneFlagDone: { color: colors.success, fontWeight: '700' },
  waitingBanner: {
    backgroundColor: '#FFF7ED', borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6, marginTop: 6,
  },
  waitingText: { fontSize: 12, fontWeight: '600', color: '#D97706' },
  verifiedRow: {
    backgroundColor: colors.accentLight, borderRadius: 10,
    padding: 10, marginTop: 8,
  },
  verifiedText: { fontSize: 13, fontWeight: '700', color: colors.success, marginBottom: 2 },
  paymentText: { fontSize: 12, color: colors.textMuted },
  reviewQuote: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', marginTop: 3 },
  actionRow: { flexDirection: 'row', marginTop: 14 },
  acceptBtn: {
    flex: 1, backgroundColor: colors.accentLight, borderRadius: 12,
    paddingVertical: 12, alignItems: 'center', marginRight: 8,
  },
  acceptText: { fontSize: 14, fontWeight: '800', color: colors.success },
  declineBtn: {
    flex: 1, backgroundColor: '#FEE2E2', borderRadius: 12,
    paddingVertical: 12, alignItems: 'center',
  },
  declineText: { fontSize: 14, fontWeight: '800', color: colors.urgent },
  markDoneBtn: {
    backgroundColor: colors.primaryLight, borderRadius: 12,
    paddingVertical: 12, alignItems: 'center', marginTop: 12,
    borderWidth: 1.5, borderColor: colors.primary,
  },
  markDoneText: { fontSize: 14, fontWeight: '800', color: colors.primary },
  verifyBtn: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  verifyText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  msgBtn: {
    borderRadius: 12, paddingVertical: 10, alignItems: 'center', marginTop: 8,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface,
  },
  msgBtnText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 60 },
  emptyIcon: { fontSize: 52, marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: colors.textPrimary, marginBottom: 8 },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
});
