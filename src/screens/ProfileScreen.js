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
import { LinearGradient } from 'expo-linear-gradient';
import GradientHeader from '../components/GradientHeader';
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
import { colors, gradients, shadows } from '../theme';


export default function ProfileScreen({ navigation }) {
  const {
    name, avatarInitial, avatarUrl, rating, reviewCount,
    memberSince, levelInfo, xp, badges, earningsTotal,
    weeklyJobsDone, weeklyEarningGoal, weeklyJobsGoal, setGoals, refreshProfile, showToast,
    school, major, gradYear, studentVerified, studentStatus,
    profileStatus, retryProfile,
  } = useUser();
  const { postedJobs, bookedJobs, posterBookings, profileBadgeCount, getPaymentReadiness } = useJobs();
  const { signOut, user } = useAuth();
  const haptic = useHaptic();
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
      await Share.share({ message: `Join me on GoHustlr — sign up with my referral code ${code} to get started!` });
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
      <View style={[styles.container, { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }]}>
        {profileStatus === 'loading' ? (
          <>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={{ marginTop: 14, fontSize: 14, color: colors.textSecondary }}>Loading your profile…</Text>
          </>
        ) : (
          <>
            <Ionicons name="cloud-offline-outline" size={44} color={colors.textMuted} />
            <Text style={{ marginTop: 12, fontSize: 17, fontWeight: '800', color: colors.textPrimary }}>
              Couldn't load your profile
            </Text>
            <Text style={{ marginTop: 6, fontSize: 13, color: colors.textSecondary, textAlign: 'center' }}>
              Check your connection and try again — your account and data are safe.
            </Text>
            <TouchableOpacity onPress={retryProfile} style={{ marginTop: 18 }} activeOpacity={0.85}>
              <LinearGradient colors={gradients.primary} style={{ borderRadius: 14, paddingVertical: 12, paddingHorizontal: 32 }}>
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800' }}>Try again</Text>
              </LinearGradient>
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
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <GradientHeader colors={gradients.profile}>
        <View style={styles.profileRow}>
          <TouchableOpacity onPress={handlePickAvatar} activeOpacity={0.8} style={styles.avatarWrap}>
            <Avatar
              url={avatarUrl}
              initial={avatarInitial}
              size={64}
              fontSize={26}
              bg="rgba(255,255,255,0.25)"
              borderColor="rgba(255,255,255,0.6)"
              borderWidth={3}
            />
            <View style={styles.avatarBadge}>
              {uploadingAvatar
                ? <ActivityIndicator size="small" color="#fff" />
                : <Ionicons name="camera" size={14} color="#fff" />}
            </View>
          </TouchableOpacity>
          <View style={styles.profileInfo}>
            <View style={styles.nameRow}>
              <Text style={styles.profileName}>{name}</Text>
              {idv.verified && (
                <Ionicons name="shield-checkmark" size={18} color="#fff" style={{ marginLeft: 6 }} />
              )}
              {studentVerified && (
                <Ionicons name="school" size={16} color="#fff" style={{ marginLeft: 6 }} />
              )}
            </View>
            {actualReviewCount > 0 && <RatingStars rating={actualRating} size={14} />}
            {!!college && <Text style={styles.profileCollege}>{college}</Text>}
            <Text style={styles.profileSub}>
              {actualReviewCount > 0
                ? `${actualReviewCount} review${actualReviewCount !== 1 ? 's' : ''}`
                : 'No reviews yet'} · Member since {memberSince}
            </Text>
          </View>
        </View>
        <XPBar levelInfo={levelInfo} xp={xp} dark />
      </GradientHeader>

      {paymentAlert && (
        <TouchableOpacity
          style={styles.payAlert}
          onPress={() => { haptic.medium(); navigation.navigate('PayoutSetup'); }}
          activeOpacity={0.85}
        >
          <View style={styles.payAlertIcon}>
            <Ionicons name="card" size={18} color="#fff" />
          </View>
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={styles.payAlertTitle}>{paymentAlert.title}</Text>
            <Text style={styles.payAlertSub}>{paymentAlert.sub}</Text>
          </View>
        </TouchableOpacity>
      )}

      <View style={styles.statsRow}>
        <Stat label="Jobs Done" value={weeklyJobsDone} />
        <View style={styles.statDiv} />
        <Stat label="Total Earned" value={`$${earningsTotal.toLocaleString()}`} />
        <View style={styles.statDiv} />
        <Stat label="Avg Rating" value={actualReviewCount > 0 ? actualRating.toFixed(1) + ' ★' : '—'} />
      </View>

      {/* Primary action — edit the identity shown in the header above */}
      <TouchableOpacity
        style={styles.editProfileBtn}
        onPress={() => { haptic.medium(); navigation.navigate('Settings'); }}
        activeOpacity={0.85}
      >
        <Ionicons name="create-outline" size={18} color="#fff" style={{ marginRight: 8 }} />
        <Text style={styles.editProfileText}>Edit Profile & Settings</Text>
      </TouchableOpacity>

      <Group title="Gigs & Earnings">
        {(postedJobs.length > 0 || posterBookings?.length > 0) && (
          <Row
            icon="briefcase-outline"
            title="Manage My Gigs"
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

      <Group title="Saved & Alerts">
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
          title="Saved Gigs"
          sub="Gigs you've bookmarked to book later"
          onPress={() => { haptic.medium(); navigation.navigate('SavedGigs'); }}
        />
        <Row
          icon="heart-outline"
          title="Saved People"
          sub="Workers & clients you've favorited"
          onPress={() => { haptic.medium(); navigation.navigate('Favorites'); }}
          last
        />
      </Group>

      <Group title="Profile & Trust">
        <Row
          icon="eye-outline"
          title="View My Public Profile"
          sub="See exactly how others see you"
          onPress={() => { haptic.medium(); if (user) navigation.navigate('UserProfile', { userId: user.id }); }}
        />
        <Row
          icon={idv.verified ? 'shield-checkmark' : idv.status === 'pending' ? 'hourglass-outline' : idv.status === 'rejected' ? 'alert-circle-outline' : 'shield-outline'}
          iconColor={idv.verified ? colors.success : idv.status === 'rejected' ? colors.urgent : colors.primary}
          title={idv.verified ? 'Identity Verified' : idv.status === 'pending' ? 'Verification In Progress' : idv.status === 'rejected' ? 'Verification Failed' : 'Verify Your Identity'}
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
        />
        <Row
          icon="time-outline"
          title="Availability & Schedule"
          sub="Set your work status, hours & classes"
          onPress={() => { haptic.medium(); navigation.navigate('Availability'); }}
          last
        />
      </Group>

      <Group title="Grow">
        <Row
          icon="gift-outline"
          title="Invite Friends"
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
        <Text style={styles.sectionTitle}>Reviews I've Received</Text>
        {myReviews.length > 0 && (() => {
          const w = myReviews.filter(r => r.role === 'earner');
          const c = myReviews.filter(r => r.role === 'poster');
          const a = (arr) => arr.length ? (arr.reduce((s, r) => s + (r.rating || 0), 0) / arr.length).toFixed(1) : '—';
          return (
            <View style={styles.breakdownRow}>
              <Text style={styles.breakdownItem}>As a worker: <Text style={styles.breakdownVal}>{a(w)}</Text> ({w.length})</Text>
              <Text style={styles.breakdownItem}>As a client: <Text style={styles.breakdownVal}>{a(c)}</Text> ({c.length})</Text>
            </View>
          );
        })()}
        {myReviews.length === 0 ? (
          <View style={styles.noReviewsCard}>
            <Ionicons name="star-outline" size={30} color={colors.gold} style={styles.noReviewsIcon} />
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
                  style={{ marginRight: 10 }}
                />
                <View style={styles.reviewerInfo}>
                  <Text style={styles.reviewerName}>{r.reviewer?.name || r.author || 'Poster'}</Text>
                  <View style={styles.reviewStarsRow}>
                    {[1,2,3,4,5].map(s => (
                      <Ionicons
                        key={s}
                        name={s <= Math.round(r.rating) ? 'star' : 'star-outline'}
                        size={12}
                        color={s <= Math.round(r.rating) ? colors.gold : colors.border}
                        style={styles.reviewStar}
                      />
                    ))}
                    <Text style={styles.reviewRatingNum}>{Number(r.rating).toFixed(1)}</Text>
                  </View>
                </View>
                {r.date && <Text style={styles.reviewDate}>{r.date}</Text>}
              </View>
              {r.text ? <Text style={styles.reviewText}>{r.text}</Text> : null}
            </View>
          ))
        )}
      </View>

      <View style={styles.legalSection}>
        <Text style={styles.legalHeader}>Legal & Support</Text>
        <TouchableOpacity style={styles.legalRow} onPress={() => navigation.navigate('Legal', { doc: 'terms' })}>
          <Text style={styles.legalRowText}>Terms of Service</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.legalRow} onPress={() => navigation.navigate('Legal', { doc: 'privacy' })}>
          <Text style={styles.legalRowText}>Privacy Policy</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.legalRow} onPress={() => navigation.navigate('Legal', { doc: 'contractor' })}>
          <Text style={styles.legalRowText}>Independent Contractor Agreement</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity style={[styles.legalRow, { borderBottomWidth: 0 }]} onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=GoHustlr%20Support`)}>
          <Text style={styles.legalRowText}>Contact Support</Text>
          <Ionicons name="mail-outline" size={16} color={colors.textMuted} />
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={styles.signOutBtn}
        onPress={() => { haptic.medium(); signOut(); }}
      >
        <Text style={styles.signOutText}>Sign Out</Text>
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
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
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
      <View style={[styles.rowIconTile, { backgroundColor: tint + '18' }]}>
        <Ionicons name={icon} size={18} color={tint} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
        {sub ? <Text style={styles.rowSub} numberOfLines={1}>{sub}</Text> : null}
      </View>
      {badge ? (
        <View style={[styles.rowBadge, badgeColor ? { backgroundColor: badgeColor } : null]}>
          <Text style={styles.rowBadgeText}>{badge}</Text>
        </View>
      ) : null}
      {!disabled && <Ionicons name="chevron-forward" size={18} color={colors.textMuted} style={{ marginLeft: 4 }} />}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  // Grouped-list profile menu (iOS-Settings style)
  editProfileBtn: {
    marginHorizontal: 16, marginTop: 16, borderRadius: 14,
    paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary, ...shadows.sm,
  },
  editProfileText: { fontSize: 15, fontWeight: '800', color: '#fff' },
  group: { marginHorizontal: 16, marginTop: 22 },
  groupTitle: {
    fontSize: 12, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8, marginLeft: 4,
  },
  groupCard: {
    backgroundColor: colors.surface, borderRadius: 16,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden', ...shadows.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 14 },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowIconTile: {
    width: 32, height: 32, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  rowBadge: {
    backgroundColor: colors.urgent, borderRadius: 10, minWidth: 20,
    paddingHorizontal: 7, paddingVertical: 2, alignItems: 'center', marginLeft: 6,
  },
  rowBadgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  manageBtn: {
    marginHorizontal: 16, marginTop: 12, borderRadius: 14,
    backgroundColor: colors.surface, paddingVertical: 14, paddingHorizontal: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  manageBtnLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  manageBtnIcon: { fontSize: 22, marginRight: 12 },
  manageBtnTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  manageBtnSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  manageBadge: {
    backgroundColor: colors.urgent, borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 3, marginRight: 8,
  },
  manageBadgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  alertBadge: {
    backgroundColor: colors.primary, borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 3, marginRight: 8,
  },
  alertBadgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  manageBtnArrow: { fontSize: 20, color: colors.textMuted, fontWeight: '400' },
  settingsBtn: {
    marginHorizontal: 16, marginTop: 16, borderRadius: 14,
    paddingVertical: 14, alignItems: 'center',
    backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border,
  },
  settingsBtnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  settingsBtnText: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  legalSection: {
    marginHorizontal: 16, marginTop: 16, borderRadius: 14,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 16, paddingTop: 10,
  },
  legalHeader: {
    fontSize: 13, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8,
  },
  legalRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.divider,
  },
  legalRowText: { fontSize: 14, color: colors.textPrimary, fontWeight: '600' },
  signOutBtn: {
    marginHorizontal: 16, marginTop: 12, borderRadius: 14,
    paddingVertical: 14, alignItems: 'center',
    backgroundColor: colors.surface, borderWidth: 1.5, borderColor: '#FCA5A5',
  },
  signOutText: { fontSize: 15, fontWeight: '700', color: colors.urgent },
  container: { flex: 1, backgroundColor: colors.background },
  profileRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  avatarWrap: { marginRight: 16 },
  avatarBadge: {
    position: 'absolute', right: -2, bottom: -2,
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: colors.primary, borderWidth: 2, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  avatar: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center', justifyContent: 'center', marginRight: 16,
  },
  avatarText: { color: '#fff', fontWeight: '900', fontSize: 26 },
  profileInfo: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  profileName: { fontSize: 22, fontWeight: '900', color: '#fff' },
  profileSub: { fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 4 },
  profileCollege: { fontSize: 12, color: 'rgba(255,255,255,0.92)', marginTop: 4, fontWeight: '700' },
  roleToggle: {
    backgroundColor: colors.surface, marginHorizontal: 16, marginTop: 16,
    borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  roleLabel: { fontSize: 15, fontWeight: '800', color: colors.textPrimary },
  roleRight: { flexDirection: 'row', alignItems: 'center' },
  roleHint: { fontSize: 12, color: colors.textMuted, marginRight: 10 },
  payAlert: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.primary,
    marginHorizontal: 16, marginTop: 12,
    borderRadius: 14, padding: 14,
    ...shadows.sm,
  },
  payAlertIcon: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  payAlertTitle: { color: '#fff', fontSize: 13.5, fontWeight: '800' },
  payAlertSub: { color: 'rgba(255,255,255,0.78)', fontSize: 12, marginTop: 1 },
  statsRow: {
    backgroundColor: colors.surface, marginHorizontal: 16, marginTop: 12,
    borderRadius: 16, flexDirection: 'row', alignItems: 'center',
    paddingVertical: 16, borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: 20, fontWeight: '800', color: colors.textPrimary, marginBottom: 4 },
  statLabel: { fontSize: 10, color: colors.textMuted, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  statDiv: { width: 1, height: 32, backgroundColor: colors.border },
  section: { paddingHorizontal: 16, marginTop: 24 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle: {
    fontSize: 13, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 12,
  },
  postedJobCard: {
    backgroundColor: colors.surface, borderRadius: 14, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
    flexDirection: 'row', alignItems: 'center',
  },
  postedJobInfo: { flex: 1, marginRight: 10 },
  postedJobTitle: { fontSize: 14, fontWeight: '800', color: colors.textPrimary, marginBottom: 3 },
  postedJobMeta: { fontSize: 12, color: colors.textMuted },
  postedJobActions: { flexDirection: 'row' },
  editBtn: {
    backgroundColor: colors.primaryLight, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 7,
    borderWidth: 1, borderColor: colors.primary + '40',
  },
  editBtnText: { fontSize: 12, fontWeight: '800', color: colors.primary },
  emptyText: { fontSize: 13, color: colors.textMuted, fontStyle: 'italic' },
  breakdownRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  breakdownItem: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  breakdownVal: { color: colors.textPrimary, fontWeight: '800' },
  noReviewsCard: {
    backgroundColor: colors.surface, borderRadius: 14, padding: 20,
    alignItems: 'center', borderWidth: 1, borderColor: colors.border,
  },
  noReviewsIcon: { fontSize: 30, marginBottom: 8 },
  noReviewsTitle: { fontSize: 15, fontWeight: '800', color: colors.textPrimary, marginBottom: 4 },
  noReviewsText: { fontSize: 13, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  reviewCard: {
    backgroundColor: colors.surface, borderRadius: 14,
    padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  reviewHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  reviewerAvatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', marginRight: 10,
  },
  reviewerAvatarText: { color: '#fff', fontWeight: '900', fontSize: 14 },
  reviewerInfo: { flex: 1 },
  reviewerName: { fontSize: 13, fontWeight: '800', color: colors.textPrimary, marginBottom: 3 },
  reviewStarsRow: { flexDirection: 'row', alignItems: 'center' },
  reviewStar: { fontSize: 12, color: colors.border, marginRight: 1 },
  reviewStarFilled: { color: '#F59E0B' },
  reviewRatingNum: { fontSize: 11, color: colors.textMuted, marginLeft: 4, fontWeight: '700' },
  reviewDate: { fontSize: 11, color: colors.textMuted },
  reviewText: { fontSize: 13, color: colors.textSecondary, lineHeight: 20 },
});
