import React, { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import BookingStatusBadge from '../components/BookingStatusBadge';
import CompletionModal from '../components/CompletionModal';
import MessageSheet from '../components/MessageSheet';
import ScreenHeader from '../components/ScreenHeader';
import { colors, radii, shadows } from '../theme';

const SECTION_ORDER  = ['pending', 'completed', 'confirmed', 'verified', 'declined'];
const SECTION_TITLES = {
  pending:   'Action needed — new requests',
  completed: 'Both marked done — verify now',
  confirmed: 'Confirmed — in progress',
  verified:  'Completed',
  declined:  'Declined',
};
const ACTIVE_STATUSES = new Set(['pending', 'confirmed', 'completed']);

export default function ManageBookingsScreen() {
  const { posterBookings, declineBooking, verifyAndRate, markPosterDone, refreshPosterBookings } = useJobs();
  const { showToast } = useUser();
  const navigation = useNavigation();
  const haptic = useHaptic();
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
    // Accepting requires authorizing the escrow card hold, which lives in the Hire
    // tab's accept flow (GigsScreen → AcceptPaymentModal). This legacy screen has no
    // payment step, so route the poster there instead of attempting a confirm that
    // the server would reject for having no funded hold.
    haptic.selection();
    showToast({ icon: '💳', title: 'Accept from Hire', message: 'Open the gig in the Hire tab to authorize payment and accept.' });
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
      <ScreenHeader>
        <Text style={styles.headerTitle} numberOfLines={1}>Manage bookings</Text>
        <Text style={styles.headerSub} numberOfLines={2}>
          {posterBookings.length === 0
            ? 'No bookings yet on your gigs'
            : `${posterBookings.length} booking${posterBookings.length !== 1 ? 's' : ''} across your gigs`}
        </Text>
      </ScreenHeader>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {isEmpty && (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Ionicons name="mail-open-outline" size={26} color={colors.textMuted} />
            </View>
            <Text style={styles.emptyTitle}>No bookings yet</Text>
            <Text style={styles.emptyText}>When students book your gigs they'll appear here for you to accept or decline.</Text>
          </View>
        )}

        {SECTION_ORDER.map(status => {
          const items = grouped[status];
          if (!items) return null;
          return (
            <View key={status} style={styles.section}>
              <Text style={styles.sectionTitle} numberOfLines={2}>{SECTION_TITLES[status]}</Text>
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
          <Text style={styles.earnerName} numberOfLines={1}>{earnerName}</Text>
          {booking.earner?.reviewCount > 0
            ? <Text style={styles.earnerRating} numberOfLines={1}>{Number(rating).toFixed(1)} rating</Text>
            : <Text style={styles.earnerRating} numberOfLines={1}>New</Text>}
        </View>
        <View style={styles.badgeWrap}>
          <BookingStatusBadge status={status} compact />
        </View>
      </View>

      {/* Job info */}
      <View style={styles.jobRow}>
        <Text style={styles.jobTitle} numberOfLines={2}>{jobTitle}</Text>
        {pay ? (
          <Text style={styles.jobPay} numberOfLines={1}>{payType === 'hourly' ? `$${pay}/hr` : `$${pay} flat`}</Text>
        ) : null}
      </View>

      {booking.slotLabel && (
        <View style={styles.infoRow}>
          <Ionicons name="calendar-outline" size={13} color={colors.textMuted} style={styles.infoIcon} />
          <Text style={styles.infoText}>{booking.slotLabel}</Text>
        </View>
      )}
      {booking.counterOffer && (
        <View style={styles.infoRow}>
          <Ionicons name="chatbubble-ellipses-outline" size={13} color={colors.textMuted} style={styles.infoIcon} />
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
          <Text style={styles.inProgressText} numberOfLines={1}>In progress</Text>
        </View>
      )}

      {/* Done-flag indicators */}
      {status === 'confirmed' && (booking.earnerDone || booking.posterDone) && (
        <View style={styles.doneFlags}>
          <View style={styles.doneFlagRow}>
            <Ionicons
              name={booking.earnerDone ? 'checkmark-circle' : 'ellipse-outline'}
              size={14}
              color={booking.earnerDone ? colors.success : colors.textMuted}
              style={styles.doneFlagIcon}
            />
            <Text style={[styles.doneFlagItem, booking.earnerDone && styles.doneFlagDone]} numberOfLines={1}>
              Earner confirmed done
            </Text>
          </View>
          <View style={styles.doneFlagRow}>
            <Ionicons
              name={booking.posterDone ? 'checkmark-circle' : 'ellipse-outline'}
              size={14}
              color={booking.posterDone ? colors.success : colors.textMuted}
              style={styles.doneFlagIcon}
            />
            <Text style={[styles.doneFlagItem, booking.posterDone && styles.doneFlagDone]} numberOfLines={1}>
              You confirmed done
            </Text>
          </View>
        </View>
      )}

      {/* Waiting banner — poster marked done but earner hasn't */}
      {status === 'confirmed' && booking.posterDone && !booking.earnerDone && (
        <View style={styles.waitingBanner}>
          <Text style={styles.waitingText} numberOfLines={2}>Waiting for earner to confirm…</Text>
        </View>
      )}

      {/* Verified result */}
      {status === 'verified' && booking.earnerRating && (
        <View style={styles.verifiedRow}>
          <Text style={styles.verifiedText} numberOfLines={2}>
            You rated {earnerName} {Math.round(booking.earnerRating)} out of 5
          </Text>
          {booking.paymentMethod && (
            <Text style={styles.paymentText} numberOfLines={1}>
              Paid via {booking.paymentMethod.charAt(0).toUpperCase() + booking.paymentMethod.slice(1)}
            </Text>
          )}
        </View>
      )}
      {status === 'verified' && booking.posterRating && (
        <View style={[styles.verifiedRow, { marginTop: 8 }]}>
          <Text style={styles.verifiedText} numberOfLines={2}>
            {earnerName} rated you {booking.posterRating} out of 5
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
              <TouchableOpacity style={styles.acceptBtn} onPress={onAccept} activeOpacity={0.85}>
                <Text style={styles.acceptText} numberOfLines={1}>Accept</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.declineBtn} onPress={onDecline} activeOpacity={0.85}>
                <Text style={styles.declineText} numberOfLines={1}>Decline</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Mark Done — poster side, when confirmed and poster hasn't marked yet */}
          {status === 'confirmed' && !booking.posterDone && (
            <TouchableOpacity style={styles.markDoneBtn} onPress={onMarkDone} activeOpacity={0.85}>
              <Text style={styles.markDoneText} numberOfLines={1}>Mark job done</Text>
            </TouchableOpacity>
          )}

          {/* Verify & Rate — when both marked done (completed) */}
          {status === 'completed' && (
            <TouchableOpacity style={styles.verifyBtn} onPress={onVerify} activeOpacity={0.85}>
              <Text style={styles.verifyText} numberOfLines={1}>{`Verify & rate ${earnerName}`}</Text>
            </TouchableOpacity>
          )}

          {/* Message — all active statuses */}
          {ACTIVE_STATUSES.has(status) && (
            <TouchableOpacity style={styles.msgBtn} onPress={onMessage} activeOpacity={0.85}>
              <Text style={styles.msgBtnText} numberOfLines={1}>Message {earnerName}</Text>
            </TouchableOpacity>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  headerTitle: {
    fontSize: 24, fontWeight: '700', color: colors.textPrimary,
    letterSpacing: -0.4, marginBottom: 4,
  },
  headerSub: { fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
  scroll: { flex: 1 },
  section: { paddingHorizontal: 20, marginTop: 24 },
  sectionTitle: {
    fontSize: 13, fontWeight: '600', color: colors.textMuted,
    marginBottom: 12, lineHeight: 18,
  },
  card: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    padding: 16, marginBottom: 12,
    ...shadows.card,
  },
  earnerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  avatar: {
    width: 42, height: 42, borderRadius: radii.pill,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 17 },
  earnerInfo: { flex: 1, marginRight: 8 },
  earnerName: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  earnerRating: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  badgeWrap: { flexShrink: 0 },
  jobRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  jobTitle: {
    fontSize: 14, fontWeight: '600', color: colors.textPrimary,
    flexShrink: 1, marginRight: 8, lineHeight: 19,
  },
  jobPay: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, flexShrink: 0 },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 4 },
  infoIcon: { marginRight: 6, marginTop: 2 },
  infoText: { fontSize: 12, color: colors.textSecondary, flex: 1, lineHeight: 18 },
  counterValue: { fontWeight: '700', color: colors.textPrimary },
  inProgressBanner: {
    backgroundColor: colors.successLight, borderRadius: radii.sm,
    paddingHorizontal: 10, paddingVertical: 6, marginTop: 8, alignSelf: 'flex-start',
  },
  inProgressText: { fontSize: 12, fontWeight: '600', color: colors.success },
  doneFlags: { marginTop: 8 },
  doneFlagRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  doneFlagIcon: { marginRight: 6 },
  doneFlagItem: { fontSize: 12, color: colors.textMuted, flex: 1, lineHeight: 17 },
  doneFlagDone: { color: colors.success, fontWeight: '600' },
  waitingBanner: {
    backgroundColor: colors.background, borderRadius: radii.sm,
    paddingHorizontal: 10, paddingVertical: 8, marginTop: 8, alignSelf: 'flex-start',
  },
  waitingText: { fontSize: 12, fontWeight: '500', color: colors.textSecondary, lineHeight: 17 },
  verifiedRow: {
    backgroundColor: colors.successLight, borderRadius: radii.md,
    padding: 12, marginTop: 8,
  },
  verifiedText: { fontSize: 13, fontWeight: '600', color: colors.success, marginBottom: 2, lineHeight: 18 },
  paymentText: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  reviewQuote: { fontSize: 12, color: colors.textSecondary, fontStyle: 'italic', marginTop: 4, lineHeight: 17 },
  actionRow: { flexDirection: 'row', marginTop: 16 },
  acceptBtn: {
    flex: 1, backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 13, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center',
    marginRight: 8,
  },
  acceptText: { fontSize: 15, fontWeight: '600', color: '#fff' },
  declineBtn: {
    flex: 1, backgroundColor: colors.surface, borderRadius: radii.md,
    paddingVertical: 13, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  declineText: { fontSize: 15, fontWeight: '600', color: colors.urgent },
  markDoneBtn: {
    backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 13, paddingHorizontal: 16,
    alignItems: 'center', justifyContent: 'center', marginTop: 12,
  },
  markDoneText: { fontSize: 15, fontWeight: '600', color: '#fff' },
  verifyBtn: {
    backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 14, paddingHorizontal: 16,
    alignItems: 'center', justifyContent: 'center', marginTop: 12,
  },
  verifyText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  msgBtn: {
    borderRadius: radii.md, minHeight: 44, paddingVertical: 12, paddingHorizontal: 16,
    alignItems: 'center', justifyContent: 'center', marginTop: 8,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  msgBtnText: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 60 },
  emptyIcon: {
    width: 56, height: 56, borderRadius: radii.pill,
    backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
});
