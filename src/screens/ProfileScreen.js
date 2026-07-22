import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, RefreshControl, ActivityIndicator, Linking, Share, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SUPPORT_EMAIL } from '../lib/legal';
import { getReferralCode, fetchReferralCount } from '../lib/referrals';
import { fetchVerificationStatus, requestVerification } from '../lib/verification';
import { getUnreadCount } from '../lib/notifications';
import { supabase } from '../lib/supabase';
import ScreenHeader from '../components/ScreenHeader';
import BadgeGrid from '../components/BadgeGrid';
import XPBar from '../components/XPBar';
import RatingStars from '../components/RatingStars';
import Avatar from '../components/Avatar';
import StudentVerifyModal from '../components/StudentVerifyModal';
import { collegeLine } from '../lib/school';
import { pickImage, uploadImage } from '../lib/uploadImage';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { useAuth } from '../context/AuthContext';
import { useFocusEffect } from '@react-navigation/native';
import { useHaptic } from '../hooks/useHaptic';
import { useTabBarScrollHandler } from '../lib/tabBarScroll';
import { colors, radii, shadows } from '../theme';


export default function ProfileScreen({ navigation }) {
  const {
    name, avatarInitial, avatarUrl, rating, reviewCount,
    memberSince, levelInfo, xp, badges, earningsTotal,
    weeklyEarningGoal, weeklyJobsGoal, setGoals, refreshProfile, showToast,
    school, major, gradYear, studentVerified, studentStatus,
    profileStatus, retryProfile,
  } = useUser();
  const { postedJobs, bookedJobs, bookings, posterBookings, profileBadgeCount, getPaymentReadiness } = useJobs();
  const { signOut, user } = useAuth();
  const haptic = useHaptic();
  const onTabBarScroll = useTabBarScrollHandler();
  const [payReady, setPayReady] = useState(null); // { payoutReady, paymentMethodReady }
  const [editGoals, setEditGoals] = useState(false);
  const [earGoal, setEarGoal] = useState(String(weeklyEarningGoal));
  const [jobGoal, setJobGoal] = useState(String(weeklyJobsGoal));
  const [myReviews, setMyReviews] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [refCount, setRefCount] = useState(0);
  const [idv, setIdv] = useState({ verified: false, status: 'none' });
  const [alertCount, setAlertCount] = useState(0);
  const [showStudentVerify, setShowStudentVerify] = useState(false);
  const college = collegeLine({ school, major, gradYear });

  const handleInvite = async () => {
    haptic.medium();
    try {
      const code = await getReferralCode(user.id);
      await Share.share({ message: `Join me on GoHustlr — sign up with my referral code ${code} to get started!\n\nhttps://gohustlr.com` });
    } catch (_) {}
  };

  const handlePickAvatar = async () => {
    const picked = await pickImage({ allowsEditing: true, aspect: [1, 1] });
    if (picked.canceled) {
      if (picked.denied) showToast({ icon: '⚠️', title: 'Photos access needed', message: 'Allow photo access in Settings to set a profile picture.' });
      return;
    }
    setUploadingAvatar(true);
    try {
      const url = await uploadImage({ uri: picked.uri, bucket: 'avatars', userId: user.id });
      const { error } = await supabase.from('profiles').update({ avatar_url: url }).eq('id', user.id);
      if (error) throw error;
      await refreshProfile();
      haptic.success();
      showToast({ icon: '✅', title: 'Photo updated!', message: 'Your new profile picture is live.' });
    } catch (e) {
      showToast({ icon: '⚠️', title: 'Upload failed', message: e.message || 'Please try again.' });
    }
    setUploadingAvatar(false);
  };

  const loadReviews = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from('reviews')
      .select('id, rating, text, date, author, role, reviewer:profiles!reviewer_id(name, avatar_initial, avatar_url)')
      .eq('reviewed_user_id', user.id)
      .order('created_at', { ascending: false });
    if (data) setMyReviews(data);
  }, [user?.id]);

  useFocusEffect(
    useCallback(() => {
      loadReviews();
      getPaymentReadiness().then(setPayReady).catch(() => {});
      if (user) fetchReferralCount(user.id).then(setRefCount).catch(() => {});
      if (user) fetchVerificationStatus(user.id).then(setIdv).catch(() => {});
      if (user) getUnreadCount().then(setAlertCount).catch(() => {});
    }, [loadReviews])
  );

  const startVerification = async () => {
    try {
      const res = await requestVerification();
      if (res?.alreadyVerified) {
        setIdv({ verified: true, status: 'verified' });
        showToast({ icon: '✅', title: 'Already verified', message: 'Your identity is verified.' });
        return;
      }
      if (!res?.url) throw new Error('No verification URL returned');
      setIdv(prev => ({ ...prev, status: 'pending' }));
      haptic.success();
      await Linking.openURL(res.url);
    } catch (e) {
      showToast({ icon: '⚠️', title: 'Could not start', message: e.message || 'Please try again.' });
    }
  };

  const handleVerify = async () => {
    if (idv.verified) return;
    haptic.medium();
    // Alert.alert's buttons are a no-op on react-native-web (Expo web build), which
    // stranded the flow there. Start directly on web; keep the native confirm dialog.
    if (Platform.OS === 'web') { startVerification(); return; }
    Alert.alert(
      'Verify your identity',
      "We'll confirm your government ID and a selfie through Stripe to give your profile a Verified badge. This builds trust with people you work with. Continue?",
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Start', onPress: startVerification },
      ]
    );
  };

  // Everyone can both earn and hire, so prompt for both payment sides.
  const showEarn = true;
  const showPay  = true;
  const needsPayout = showEarn && payReady && !payReady.payoutReady;
  const needsCard   = showPay && payReady && !payReady.paymentMethodReady;
  const paymentAlert = (needsPayout && needsCard)
    ? { title: 'Finish setting up payments', sub: 'Connect a bank and add a card →' }
    : needsPayout
      ? { title: 'Set up payouts to get paid', sub: 'Connect your bank to receive earnings →' }
      : needsCard
        ? { title: 'Add a payment method to hire', sub: 'Save a card so you can book gigs →' }
        : null;

  // Subtitle for the always-visible Payments row
  const paymentsSub = !payReady
    ? 'Manage your payment info'
    : (showPay && !showEarn)
      ? (payReady.paymentMethodReady ? 'Card on file · tap to change' : 'Add a payment method')
      : (showEarn && !showPay)
        ? (payReady.payoutReady ? 'Payouts active · tap to manage' : 'Set up payouts to get paid')
        : 'Manage payout & payment methods';

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshProfile(), loadReviews()]);
    setRefreshing(false);
  };

  // Derive rating + count from actual loaded reviews (source of truth)
  const actualReviewCount = myReviews.length;
  const actualRating = actualReviewCount > 0
    ? myReviews.reduce((sum, r) => sum + (r.rating || 0), 0) / actualReviewCount
    : null;

  const saveGoals = () => {
    const eg = parseInt(earGoal) || weeklyEarningGoal;
    const jg = parseInt(jobGoal) || weeklyJobsGoal;
    setGoals(eg, jg);
    setEditGoals(false);
    haptic.success();
    showToast({ icon: '🎯', title: 'Goals updated!', message: 'Your weekly goals have been saved.' });
  };

  // Never render placeholder profile data as if it were the user's account — a
  // failed load must look like a load problem, not like a blank account.
  if (profileStatus !== 'ready') {
    return (
      <View style={[styles.container, styles.stateWrap]}>
        {profileStatus === 'loading' ? (
          <>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.stateLoadingText}>Loading your profile…</Text>
          </>
        ) : (
          <>
            <Ionicons name="cloud-offline-outline" size={44} color={colors.textMuted} />
            <Text style={styles.stateTitle}>
              Couldn't load your profile
            </Text>
            <Text style={styles.stateBody}>
              Check your connection and try again — your account and data are safe.
            </Text>
            <TouchableOpacity onPress={retryProfile} style={styles.stateBtn} activeOpacity={0.85}>
              <Text style={styles.stateBtnText} numberOfLines={1}>Try again</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: 140 }}
      onScroll={onTabBarScroll}
      scrollEventThrottle={32}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <ScreenHeader>
        <View style={styles.profileRow}>
          <TouchableOpacity onPress={handlePickAvatar} activeOpacity={0.8} style={styles.avatarWrap}>
            <Avatar
              url={avatarUrl}
              initial={avatarInitial}
              size={64}
              fontSize={26}
            />
            <View style={styles.avatarBadge}>
              {uploadingAvatar
                ? <ActivityIndicator size="small" color="#fff" />
                : <Ionicons name="camera" size={14} color="#fff" />}
            </View>
          </TouchableOpacity>
          <View style={styles.profileInfo}>
            <View style={styles.nameRow}>
              <Text style={styles.profileName} numberOfLines={1}>{name}</Text>
              {idv.verified && (
                <Ionicons name="shield-checkmark" size={18} color={colors.success} style={styles.nameIcon} />
              )}
              {studentVerified && (
                <Ionicons name="school" size={16} color={colors.primary} style={styles.nameIcon} />
              )}
            </View>
            {actualReviewCount > 0 && <RatingStars rating={actualRating} size={14} />}
            {!!college && <Text style={styles.profileCollege} numberOfLines={1}>{college}</Text>}
            <Text style={styles.profileSub} numberOfLines={2}>
              {actualReviewCount > 0
                ? `${actualReviewCount} review${actualReviewCount !== 1 ? 's' : ''}`
                : 'No reviews yet'} · Member since {memberSince}
            </Text>
          </View>
        </View>
        <XPBar levelInfo={levelInfo} xp={xp} dark={false} />
      </ScreenHeader>

      {paymentAlert && (
        <TouchableOpacity
          style={styles.payAlert}
          onPress={() => { haptic.medium(); navigation.navigate('PayoutSetup'); }}
          activeOpacity={0.85}
        >
          <View style={styles.payAlertIcon}>
            <Ionicons name="card" size={18} color={colors.primary} />
          </View>
          <View style={styles.payAlertText}>
            <Text style={styles.payAlertTitle} numberOfLines={2}>{paymentAlert.title}</Text>
            <Text style={styles.payAlertSub} numberOfLines={2}>{paymentAlert.sub}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} style={styles.payAlertChevron} />
        </TouchableOpacity>
      )}

      {/* Jobs Done counts work that actually finished (mutual completion or
          verified) — never pending/confirmed applications, which used to bump
          the stat the moment a gig was booked. */}
      <View style={styles.statsRow}>
        <Stat label="Jobs done" value={bookings.filter(b => b.status === 'completed' || b.status === 'verified').length} />
        <View style={styles.statDiv} />
        <Stat label="Total earned" value={`$${earningsTotal.toLocaleString()}`} />
        <View style={styles.statDiv} />
        <Stat label="Avg rating" value={actualReviewCount > 0 ? actualRating.toFixed(1) + ' ★' : '—'} />
      </View>

      {/* Primary action — edit the identity shown in the header above */}
      <TouchableOpacity
        style={styles.editProfileBtn}
        onPress={() => { haptic.medium(); navigation.navigate('Settings'); }}
        activeOpacity={0.85}
      >
        <Ionicons name="create-outline" size={18} color="#fff" style={styles.editProfileIcon} />
        <Text style={styles.editProfileText} numberOfLines={1}>Edit Profile & Settings</Text>
      </TouchableOpacity>

      <Group title="Gigs & earnings">
        {(postedJobs.length > 0 || posterBookings?.length > 0) && (
          <Row
            icon="briefcase-outline"
            title="Manage my gigs"
            sub={profileBadgeCount > 0 ? `${profileBadgeCount} need${profileBadgeCount === 1 ? 's' : ''} attention` : 'Posted gigs & booking requests'}
            badge={profileBadgeCount > 0 ? profileBadgeCount : null}
            onPress={() => { haptic.medium(); navigation.navigate('GigsTab'); }}
          />
        )}
        <Row
          icon="card-outline"
          title="Payments"
          sub={paymentsSub}
          onPress={() => { haptic.medium(); navigation.navigate('PayoutSetup'); }}
        />
        <Row
          icon="receipt-outline"
          title="Tax Center"
          sub="Track expenses & export for taxes"
          onPress={() => { haptic.medium(); navigation.navigate('Expenses'); }}
          last
        />
      </Group>

      <Group title="Saved & alerts">
        <Row
          icon="notifications-outline"
          title="Alerts"
          sub="Booking updates & gig matches"
          badge={alertCount > 0 ? alertCount : null}
          badgeColor={colors.primary}
          onPress={() => { haptic.medium(); navigation.navigate('Notifications'); }}
        />
        <Row
          icon="bookmark-outline"
          title="Saved gigs"
          sub="Gigs you've bookmarked to book later"
          onPress={() => { haptic.medium(); navigation.navigate('SavedGigs'); }}
        />
        <Row
          icon="heart-outline"
          title="Saved people"
          sub="Workers & clients you've favorited"
          onPress={() => { haptic.medium(); navigation.navigate('Favorites'); }}
          last
        />
      </Group>

      <Group title="Preferences">
        <Row
          icon="options-outline"
          title="Notification settings"
          sub="Push & email preferences"
          onPress={() => { haptic.medium(); navigation.navigate('NotificationSettings'); }}
        />
        <Row
          icon="time-outline"
          title="Availability & schedule"
          sub="Set your work status, hours & classes"
          onPress={() => { haptic.medium(); navigation.navigate('Availability'); }}
          last
        />
      </Group>

      <Group title="Profile & trust">
        <Row
          icon="eye-outline"
          title="View my public profile"
          sub="See exactly how others see you"
          onPress={() => { haptic.medium(); if (user) navigation.navigate('UserProfile', { userId: user.id }); }}
        />
        <Row
          icon={idv.verified ? 'shield-checkmark' : idv.status === 'pending' ? 'hourglass-outline' : idv.status === 'rejected' ? 'alert-circle-outline' : 'shield-outline'}
          iconColor={idv.verified ? colors.success : idv.status === 'rejected' ? colors.urgent : colors.primary}
          title={idv.verified ? 'Identity verified' : idv.status === 'pending' ? 'Verification in progress' : idv.status === 'rejected' ? 'Verification failed' : 'Verify your identity'}
          sub={idv.verified
            ? 'Your profile shows a Verified badge'
            : idv.status === 'pending'
              ? 'Tap to finish or resume your ID check'
              : idv.status === 'rejected'
                ? "We couldn't verify your ID — tap to try again"
                : 'Get a Verified badge to build trust'}
          onPress={handleVerify}
          disabled={idv.verified}
        />
        <Row
          icon={studentVerified ? 'school' : 'school-outline'}
          iconColor={studentVerified ? colors.success : colors.primary}
          title={studentVerified ? (studentStatus === 'alumni' ? 'Verified Alumni' : 'Verified Student') : 'Verify Student Status'}
          sub={studentVerified ? 'Your profile shows a Verified Student badge' : 'Confirm your .edu email for a badge'}
          onPress={() => { haptic.medium(); if (!studentVerified) setShowStudentVerify(true); }}
          disabled={studentVerified}
          last
        />
      </Group>

      <Group title="Grow">
        <Row
          icon="search-outline"
          title="Find people"
          sub="Search anyone by name or username"
          onPress={() => { haptic.medium(); navigation.navigate('FindPeople'); }}
        />
        <Row
          icon="gift-outline"
          title="Invite friends"
          sub={refCount > 0 ? `${refCount} friend${refCount !== 1 ? 's' : ''} joined · share your code` : 'Share your referral code'}
          onPress={handleInvite}
          last
        />
      </Group>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Badges</Text>
        <BadgeGrid badges={badges} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Reviews I've received</Text>
        {myReviews.length > 0 && (() => {
          const w = myReviews.filter(r => r.role === 'earner');
          const c = myReviews.filter(r => r.role === 'poster');
          const a = (arr) => arr.length ? (arr.reduce((s, r) => s + (r.rating || 0), 0) / arr.length).toFixed(1) : '—';
          return (
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownItem} numberOfLines={1}>As a worker: <Text style={styles.breakdownVal}>{a(w)}</Text> ({w.length})</Text>
              <Text style={styles.breakdownItem} numberOfLines={1}>As a client: <Text style={styles.breakdownVal}>{a(c)}</Text> ({c.length})</Text>
            </View>
          );
        })()}
        {myReviews.length === 0 ? (
          <View style={styles.noReviewsCard}>
            <Ionicons name="star-outline" size={30} color={colors.accent} style={styles.noReviewsIcon} />
            <Text style={styles.noReviewsTitle}>No reviews yet</Text>
            <Text style={styles.noReviewsText}>Complete gigs as a worker or a client to start earning reviews.</Text>
          </View>
        ) : (
          myReviews.map(r => (
            <View key={r.id} style={styles.reviewCard}>
              <View style={styles.reviewHeader}>
                <Avatar
                  url={r.reviewer?.avatar_url}
                  initial={r.reviewer?.avatar_initial || r.author?.[0]}
                  size={36}
                  fontSize={14}
                  style={{ marginRight: 12 }}
                />
                <View style={styles.reviewerInfo}>
                  <Text style={styles.reviewerName} numberOfLines={1}>{r.reviewer?.name || r.author || 'Poster'}</Text>
                  <View style={styles.reviewStarsRow}>
                    {[1,2,3,4,5].map(s => (
                      <Ionicons
                        key={s}
                        name={s <= Math.round(r.rating) ? 'star' : 'star-outline'}
                        size={12}
                        color={s <= Math.round(r.rating) ? colors.accent : colors.border}
                        style={styles.reviewStar}
                      />
                    ))}
                    <Text style={styles.reviewRatingNum}>{Number(r.rating).toFixed(1)}</Text>
                  </View>
                </View>
                {r.date && <Text style={styles.reviewDate} numberOfLines={1}>{r.date}</Text>}
              </View>
              {r.text ? <Text style={styles.reviewText}>{r.text}</Text> : null}
            </View>
          ))
        )}
      </View>

      <View style={styles.legalSection}>
        <Text style={styles.legalHeader}>Legal & support</Text>
        <View style={styles.legalCard}>
          <TouchableOpacity style={styles.legalRow} onPress={() => navigation.navigate('Legal', { doc: 'terms' })}>
            <Text style={styles.legalRowText} numberOfLines={1}>Terms of Service</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} style={styles.legalRowIcon} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.legalRow} onPress={() => navigation.navigate('Legal', { doc: 'privacy' })}>
            <Text style={styles.legalRowText} numberOfLines={1}>Privacy Policy</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} style={styles.legalRowIcon} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.legalRow} onPress={() => navigation.navigate('Legal', { doc: 'contractor' })}>
            <Text style={styles.legalRowText} numberOfLines={1}>Independent Contractor Agreement</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} style={styles.legalRowIcon} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.legalRow, styles.legalRowLast]} onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=GoHustlr%20Support`)}>
            <Text style={styles.legalRowText} numberOfLines={1}>Contact support</Text>
            <Ionicons name="mail-outline" size={16} color={colors.textMuted} style={styles.legalRowIcon} />
          </TouchableOpacity>
        </View>
      </View>

      <TouchableOpacity
        style={styles.signOutBtn}
        onPress={() => { haptic.medium(); signOut(); }}
      >
        <Text style={styles.signOutText} numberOfLines={1}>Sign out</Text>
      </TouchableOpacity>

      <View style={{ height: 40 }} />

      <StudentVerifyModal
        visible={showStudentVerify}
        onClose={() => setShowStudentVerify(false)}
      />
    </ScrollView>
  );
}

function Stat({ label, value }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue} numberOfLines={1}>{value}</Text>
      <Text style={styles.statLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

// A titled group of rows rendered as one rounded card (iOS-Settings style).
function Group({ title, children }) {
  return (
    <View style={styles.group}>
      {title ? <Text style={styles.groupTitle}>{title}</Text> : null}
      <View style={styles.groupCard}>{children}</View>
    </View>
  );
}

// A single tappable row inside a Group: icon tile + title/subtitle + optional
// badge + chevron. `last` drops the divider; `disabled` hides the chevron.
function Row({ icon, iconColor, title, sub, badge, badgeColor, onPress, disabled, last }) {
  const tint = iconColor || colors.primary;
  return (
    <TouchableOpacity
      style={[styles.row, !last && styles.rowDivider]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.6}
    >
      <View style={styles.rowIconTile}>
        <Ionicons name={icon} size={18} color={tint} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
        {sub ? <Text style={styles.rowSub} numberOfLines={2}>{sub}</Text> : null}
      </View>
      {badge ? (
        <View style={[styles.rowBadge, badgeColor ? { backgroundColor: badgeColor } : null]}>
          <Text style={styles.rowBadgeText} numberOfLines={1}>{badge}</Text>
        </View>
      ) : null}
      {!disabled && <Ionicons name="chevron-forward" size={18} color={colors.textMuted} style={styles.rowChevron} />}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  // Loading / failed-load state
  stateWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  stateLoadingText: { marginTop: 16, fontSize: 14, color: colors.textSecondary },
  stateTitle: { marginTop: 12, fontSize: 17, fontWeight: '700', color: colors.textPrimary, textAlign: 'center' },
  stateBody: { marginTop: 8, fontSize: 13, color: colors.textSecondary, textAlign: 'center', lineHeight: 19 },
  stateBtn: {
    marginTop: 20, backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 12, paddingHorizontal: 32,
  },
  stateBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  // Header
  profileRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  avatarWrap: { marginRight: 16 },
  avatarBadge: {
    position: 'absolute', right: -2, bottom: -2,
    width: 24, height: 24, borderRadius: radii.pill,
    backgroundColor: colors.primary, borderWidth: 1, borderColor: colors.background,
    alignItems: 'center', justifyContent: 'center',
  },
  profileInfo: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  nameIcon: { marginLeft: 6, flexShrink: 0 },
  profileName: {
    fontSize: 24, fontWeight: '700', color: colors.textPrimary,
    letterSpacing: -0.4, flexShrink: 1,
  },
  profileCollege: { fontSize: 12, color: colors.textSecondary, marginTop: 4, fontWeight: '600' },
  profileSub: { fontSize: 12, color: colors.textMuted, marginTop: 4, lineHeight: 16 },

  // Payment nudge
  payAlert: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface,
    marginHorizontal: 20, marginTop: 12,
    borderRadius: radii.lg, padding: 16,
    ...shadows.card,
  },
  payAlertIcon: {
    width: 36, height: 36, borderRadius: radii.md,
    backgroundColor: colors.background,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  payAlertText: { flex: 1, marginLeft: 12 },
  payAlertTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '600' },
  payAlertSub: { color: colors.textMuted, fontSize: 12, marginTop: 2, lineHeight: 16 },
  payAlertChevron: { marginLeft: 8, flexShrink: 0 },

  // Stats
  statsRow: {
    backgroundColor: colors.surface, marginHorizontal: 20, marginTop: 12,
    borderRadius: radii.lg, flexDirection: 'row', alignItems: 'center',
    paddingVertical: 16, paddingHorizontal: 8,
    ...shadows.card,
  },
  stat: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  statValue: { fontSize: 20, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  statLabel: { fontSize: 12, color: colors.textMuted, fontWeight: '500' },
  statDiv: { width: 1, height: 32, backgroundColor: colors.border, flexShrink: 0 },

  // Primary CTA
  editProfileBtn: {
    marginHorizontal: 20, marginTop: 16, borderRadius: radii.md,
    paddingVertical: 14, paddingHorizontal: 20,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  editProfileIcon: { marginRight: 8, flexShrink: 0 },
  editProfileText: { fontSize: 15, fontWeight: '600', color: '#fff', flexShrink: 1 },

  // Grouped-list profile menu (iOS-Settings style)
  group: { marginHorizontal: 20, marginTop: 24 },
  groupTitle: {
    fontSize: 13, fontWeight: '600', color: colors.textMuted,
    marginBottom: 8,
  },
  groupCard: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    ...shadows.card,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.divider },
  rowIconTile: {
    width: 32, height: 32, borderRadius: radii.sm,
    backgroundColor: colors.background,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
    flexShrink: 0,
  },
  rowText: { flex: 1, marginRight: 8 },
  rowTitle: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2, lineHeight: 16 },
  rowBadge: {
    backgroundColor: colors.urgent, borderRadius: radii.pill, minWidth: 20,
    paddingHorizontal: 8, paddingVertical: 2, alignItems: 'center',
    alignSelf: 'center', flexShrink: 0,
  },
  rowBadgeText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  rowChevron: { marginLeft: 4, flexShrink: 0 },

  // Sections (Badges, Reviews)
  section: { paddingHorizontal: 20, marginTop: 24 },
  sectionTitle: {
    fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 8,
  },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12, gap: 12 },
  breakdownItem: { fontSize: 12, color: colors.textMuted, fontWeight: '500', flexShrink: 1 },
  breakdownVal: { color: colors.textPrimary, fontWeight: '700' },
  noReviewsCard: {
    backgroundColor: colors.surface, borderRadius: radii.lg, padding: 20,
    alignItems: 'center',
    ...shadows.card,
  },
  noReviewsIcon: { marginBottom: 8 },
  noReviewsTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  noReviewsText: { fontSize: 13, color: colors.textMuted, textAlign: 'center', lineHeight: 19 },
  reviewCard: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    padding: 16, marginBottom: 12,
    ...shadows.card,
  },
  reviewHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  reviewerInfo: { flex: 1, marginRight: 8 },
  reviewerName: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginBottom: 4 },
  reviewStarsRow: { flexDirection: 'row', alignItems: 'center' },
  reviewStar: { marginRight: 1 },
  reviewRatingNum: { fontSize: 11, color: colors.textMuted, marginLeft: 4, fontWeight: '600' },
  reviewDate: { fontSize: 11, color: colors.textMuted, flexShrink: 0 },
  reviewText: { fontSize: 14, color: colors.textSecondary, lineHeight: 20 },

  // Legal & support — same label-above-card pattern as Group
  legalSection: { marginHorizontal: 20, marginTop: 24 },
  legalHeader: {
    fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 8,
  },
  legalCard: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    paddingHorizontal: 16,
    ...shadows.card,
  },
  legalRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.divider,
  },
  legalRowLast: { borderBottomWidth: 0 },
  legalRowText: { fontSize: 14, color: colors.textPrimary, fontWeight: '500', flexShrink: 1, marginRight: 12 },
  legalRowIcon: { flexShrink: 0 },

  // Sign out
  signOutBtn: {
    marginHorizontal: 20, marginTop: 16, borderRadius: radii.md,
    paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center',
    backgroundColor: colors.urgentLight,
  },
  signOutText: { fontSize: 15, fontWeight: '600', color: colors.urgent },
});
