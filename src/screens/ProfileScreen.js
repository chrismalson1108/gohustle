import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, RefreshControl, ActivityIndicator, Linking, Share, Platform,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getReferralCode, fetchReferralCount } from '../lib/referrals';
import { fetchVerificationStatus, requestVerification } from '../lib/verification';
import { getUnreadCount } from '../lib/notifications';
import { supabase } from '../lib/supabase';
import ScreenHeader from '../components/ScreenHeader';
import BadgeGrid from '../components/BadgeGrid';
import ReviewCard from '../components/ReviewCard';
import XPBar from '../components/XPBar';
import RatingStars from '../components/RatingStars';
import Avatar from '../components/Avatar';
import StudentVerifyModal from '../components/StudentVerifyModal';
import SupportSheet from '../components/SupportSheet';
import MoneyGoalCard from '../components/MoneyGoalCard';
import { EarningsTiles, InsightsCard } from '../components/MonthSummaryCard';
import GoalsChallengesCard, { XpCard, ChallengesList } from '../components/GoalsChallengesCard';
import { collegeLine } from '../lib/school';
import { formatMoney } from '../lib/finance';
import { pickImage, uploadImage } from '../lib/uploadImage';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { useAuth } from '../context/AuthContext';
import { useFocusEffect } from '@react-navigation/native';
import { useHaptic } from '../hooks/useHaptic';
import { useBadgeSync } from '../hooks/useBadgeSync';
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
  const { user } = useAuth();
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
  const [supportOpen, setSupportOpen] = useState(false);
  const college = collegeLine({ school, major, gradYear });

  // Strava-style paged hub. Width comes from useWindowDimensions, NOT a module-scope
  // Dimensions.get(), which is captured once and goes stale on rotation.
  const { width: paneW } = useWindowDimensions();
  const pagerRef = useRef(null);
  const [pane, setPane] = useState(0); // 0 = Progress, 1 = Profile
  const goToPane = (i) => {
    haptic.selection();
    setPane(i);
    pagerRef.current?.scrollTo({ x: i * paneW, animated: true });
  };
  // Drive the indicator from scroll position rounding rather than onMomentumScrollEnd:
  // programmatic scrollTo doesn't reliably fire momentum-end on Android, and RNW has
  // no meaningful momentum event at all.
  const onPagerScroll = (e) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / Math.max(1, paneW));
    if (i !== pane) setPane(i);
  };
  // Keep the pager parked on a pane boundary when the window resizes (rotation/split).
  React.useEffect(() => {
    pagerRef.current?.scrollTo({ x: pane * paneW, animated: false });
  }, [paneW]);

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
  const payoutState = payReady?.payout?.state ?? 'none';
  // 'pending' = Stripe is reviewing; the user has nothing to do, so it must NOT be
  // nagged about like an unfinished setup (that circular prompt is the bug we fixed).
  const payoutWaiting = payoutState === 'pending';
  const needsPayout = showEarn && payReady && !payReady.payoutReady && !payoutWaiting;
  const needsCard   = showPay && payReady && !payReady.paymentMethodReady;
  const payoutAlertCopy = payoutState === 'restricted'
    ? { title: "There's a problem with your payout account", sub: 'Tap for details and support →' }
    : payReady?.payout?.hasAccount
      ? { title: 'Finish your payout setup', sub: 'Stripe still needs a few details →' }
      : { title: 'Set up payouts to get paid', sub: 'Connect your bank to receive earnings →' };
  const paymentAlert = (needsPayout && needsCard)
    ? { title: 'Finish setting up payments', sub: 'Connect a bank and add a card →' }
    : needsPayout
      ? payoutAlertCopy
      : needsCard
        ? { title: 'Add a payment method to hire', sub: 'Save a card so you can book gigs →' }
        : null;

  // Subtitle for the always-visible Payments row
  const paymentsSub = !payReady
    ? 'Manage your payment info'
    : (showPay && !showEarn)
      ? (payReady.paymentMethodReady ? 'Card on file · tap to change' : 'Add a payment method')
      : (showEarn && !showPay)
        ? (payReady.payoutReady
            ? 'Payouts active · tap to manage'
            : payoutWaiting
              ? 'Stripe is verifying your details'
              : payoutAlertCopy.title)
        : 'Manage payout & payment methods';

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshProfile(), loadReviews()]);
    setRefreshing(false);
  };

  // Evaluate the badge rules against live data and unlock anything earned.
  // Reviews + referral count live here, so this is the one place with the full
  // picture; unlocking is append-only so partial passes elsewhere are safe.
  useBadgeSync({ reviews: myReviews, referrals: refCount });

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
    <View style={styles.container}>
      {/* Fixed identity header — one avatar picker, one source of truth. Keeping it
          above the pager avoids two upload buttons and desynced scroll. */}
      {/* Compact hub bar. The avatar IS the entry to the full public profile, the way
          Strava's shield is — which lets the big identity block come out entirely and
          pulls both panes up by ~150pt. */}
      <ScreenHeader>
        <View style={styles.youTopRow}>
          {/* Absolutely centered so the title sits on the SCREEN's centre line. A
              flex:1 title centres in the leftover space instead, which the 36pt
              avatar and the 80pt icon pair push visibly off-centre. pointerEvents
              none keeps it from stealing taps from the controls underneath. */}
          <View style={styles.youTitleWrap} pointerEvents="none">
            <Text style={styles.youTitle} numberOfLines={1}>You</Text>
          </View>
          <TouchableOpacity
            onPress={() => { haptic.medium(); if (user) navigation.navigate('UserProfile', { userId: user.id }); }}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="View your public profile"
          >
            <Avatar url={avatarUrl} initial={avatarInitial} size={36} fontSize={15} />
          </TouchableOpacity>
          <View style={styles.youActions}>
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={() => { haptic.medium(); navigation.navigate('Notifications'); }}
              accessibilityRole="button"
              accessibilityLabel="Alerts"
            >
              <Ionicons name="notifications-outline" size={22} color={colors.textPrimary} />
              {alertCount > 0 && (
                <View style={styles.iconBadge}>
                  <Text style={styles.iconBadgeText} numberOfLines={1}>{alertCount > 9 ? '9+' : alertCount}</Text>
                </View>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={() => { haptic.medium(); navigation.navigate('Settings'); }}
              accessibilityRole="button"
              accessibilityLabel="Settings"
            >
              <Ionicons name="settings-outline" size={22} color={colors.textPrimary} />
            </TouchableOpacity>
          </View>
        </View>
      </ScreenHeader>

      {/* Pinned across BOTH panes: a "you can't get paid" nudge must never be one
          swipe or one gear-tap away from invisible. */}
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

      <View style={styles.segmentRow}>
        {['Progress', 'Profile'].map((label, i) => (
          <TouchableOpacity
            key={label}
            style={styles.segment}
            onPress={() => goToPane(i)}
            activeOpacity={0.7}
            accessibilityRole="tab"
            accessibilityState={{ selected: pane === i }}
          >
            <Text style={[styles.segmentText, pane === i && styles.segmentTextActive]} numberOfLines={1}>{label}</Text>
            <View style={[styles.segmentBar, pane === i && styles.segmentBarActive]} />
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        bounces={false}
        directionalLockEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onPagerScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── PROGRESS ── */}
        <View style={{ width: paneW }}>
          <ScrollView
            style={{ width: paneW }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 160 }}
            onScroll={onTabBarScroll}
            scrollEventThrottle={32}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          >
          {/* Jobs Done counts work that actually finished (mutual completion or
              verified) — never pending/confirmed applications, which used to bump
              the stat the moment a gig was booked. */}
          <View style={styles.statsRow}>
            <Stat label="Jobs done" value={bookings.filter(b => b.status === 'completed' || b.status === 'verified').length} />
            <View style={styles.statDiv} />
            <Stat label="Total earned" value={formatMoney(earningsTotal)} />
            <View style={styles.statDiv} />
            <Stat label="Avg rating" value={actualReviewCount > 0 ? actualRating.toFixed(1) + ' ★' : '—'} />
          </View>
            {/* Ordered most- to least-important for an earner. Money first,
                because that is what the app is for: the monthly goal (and the
                gigs that would hit it), then what you've actually made. Then
                this week's targets, then the challenges you can still act on.
                Level and insights are further down — they're nice to see, but
                nobody opens this tab to check their XP. */}
            <MoneyGoalCard navigation={navigation} />
            <EarningsTiles />
            <GoalsChallengesCard />
            <ChallengesList />
            <XpCard />
            <InsightsCard />
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Badges</Text>
            <BadgeGrid
              badges={badges}
              onPressAll={() => {
                haptic.light();
                navigation.navigate('TrophyCase', { reviews: myReviews, referrals: refCount });
              }}
            />
          </View>
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
          </ScrollView>
        </View>

        {/* ── PROFILE ── */}
        <View style={{ width: paneW }}>
          <ScrollView
            style={{ width: paneW }}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 160 }}
            onScroll={onTabBarScroll}
            scrollEventThrottle={32}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          >
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
                <Ionicons name="star-outline" size={30} color={colors.rating} style={styles.noReviewsIcon} />
                <Text style={styles.noReviewsTitle}>No reviews yet</Text>
                <Text style={styles.noReviewsText}>Complete gigs as a worker or a client to start earning reviews.</Text>
              </View>
            ) : (
              <>
                {/* Only the most recent few — the full history lives on ReviewsScreen
                    so the profile can't grow unbounded as reviews accumulate. */}
                {myReviews.slice(0, 3).map(r => <ReviewCard key={r.id} review={r} />)}
                {myReviews.length > 3 && (
                  <TouchableOpacity
                    style={styles.seeAllRow}
                    onPress={() => { haptic.light(); navigation.navigate('Reviews', { reviews: myReviews }); }}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.seeAllText} numberOfLines={1}>
                      See all {myReviews.length} reviews
                    </Text>
                    <Ionicons name="chevron-forward" size={15} color={colors.textPrimary} />
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
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
              {/* Opens the in-app form, not a mailto:. A mailto landed in a personal
                  inbox and never created a support_tickets row, so nothing a beta
                  tester reported was visible in the admin console. */}
              <TouchableOpacity style={[styles.legalRow, styles.legalRowLast]} onPress={() => setSupportOpen(true)}>
                <Text style={styles.legalRowText} numberOfLines={1}>Contact support</Text>
                <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.textMuted} style={styles.legalRowIcon} />
              </TouchableOpacity>
            </View>
          </View>
          {/* Sign out lives in Settings only. It sat at the bottom of the tab
              people open most, one mis-tap from being logged out of a session
              they'd have to re-verify by email to get back into. */}
          </ScrollView>
        </View>
      </ScrollView>

      <StudentVerifyModal
        visible={showStudentVerify}
        onClose={() => setShowStudentVerify(false)}
      />
      <SupportSheet visible={supportOpen} onClose={() => setSupportOpen(false)} />
    </View>
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
  // ── You hub chrome ──
  youTopRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 0, minHeight: 40,
  },
  youTitleWrap: {
    ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center',
  },
  youTitle: {
    fontSize: 20, fontWeight: '800', color: colors.textPrimary, letterSpacing: -0.3,
    textAlign: 'center',
  },
  youActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  iconBtn: { padding: 8, borderRadius: radii.pill },
  iconBadge: {
    position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16,
    borderRadius: 8, backgroundColor: colors.urgent,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  iconBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  segmentRow: {
    flexDirection: 'row',
    backgroundColor: colors.background,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  segment: { flex: 1, alignItems: 'center', paddingTop: 12 },
  segmentText: { fontSize: 15, fontWeight: '600', color: colors.textMuted, marginBottom: 10 },
  segmentTextActive: { color: colors.textPrimary, fontWeight: '700' },
  segmentBar: { height: 2, width: '60%', backgroundColor: 'transparent', borderRadius: 1 },
  segmentBarActive: { backgroundColor: colors.primary },

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
  seeAllRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, paddingVertical: 12,
  },
  seeAllText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },

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
});
