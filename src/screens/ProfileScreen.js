import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { LinearGradient } from 'expo-linear-gradient';
import GradientHeader from '../components/GradientHeader';
import BadgeGrid from '../components/BadgeGrid';
import XPBar from '../components/XPBar';
import RatingStars from '../components/RatingStars';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { useAuth } from '../context/AuthContext';
import { useFocusEffect } from '@react-navigation/native';
import { useHaptic } from '../hooks/useHaptic';
import { colors, gradients, shadows } from '../theme';


export default function ProfileScreen({ navigation }) {
  const {
    name, avatarInitial, rating, reviewCount,
    memberSince, levelInfo, xp, badges, earningsTotal,
    weeklyJobsDone, weeklyEarningGoal, weeklyJobsGoal, setGoals, refreshProfile,
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

  const loadReviews = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from('reviews')
      .select('id, rating, text, date, author, reviewer:profiles!reviewer_id(name, avatar_initial)')
      .eq('reviewed_user_id', user.id)
      .order('created_at', { ascending: false });
    if (data) setMyReviews(data);
  }, [user?.id]);

  useFocusEffect(
    useCallback(() => {
      loadReviews();
      getPaymentReadiness().then(setPayReady).catch(() => {});
    }, [loadReviews])
  );

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
    Alert.alert('Goals Updated!', 'Your weekly goals have been saved.');
  };

  return (
    <ScrollView
      style={styles.container}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <GradientHeader colors={gradients.profile}>
        <View style={styles.profileRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{avatarInitial}</Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>{name}</Text>
            {actualReviewCount > 0 && <RatingStars rating={actualRating} size={14} />}
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

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Badges</Text>
        <BadgeGrid badges={badges} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Reviews I've Received</Text>
        {myReviews.length === 0 ? (
          <View style={styles.noReviewsCard}>
            <Ionicons name="star-outline" size={30} color={colors.gold} style={styles.noReviewsIcon} />
            <Text style={styles.noReviewsTitle}>No reviews yet</Text>
            <Text style={styles.noReviewsText}>Complete gigs to start earning reviews from posters.</Text>
          </View>
        ) : (
          myReviews.map(r => (
            <View key={r.id} style={styles.reviewCard}>
              <View style={styles.reviewHeader}>
                <View style={styles.reviewerAvatar}>
                  <Text style={styles.reviewerAvatarText}>
                    {r.reviewer?.avatar_initial || r.author?.[0]?.toUpperCase() || '?'}
                  </Text>
                </View>
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

      {/* Manage your gigs — lives in the Gigs tab now */}
      {(postedJobs.length > 0 || posterBookings?.length > 0) && (
        <TouchableOpacity
          style={styles.manageBtn}
          onPress={() => { haptic.medium(); navigation.navigate('GigsTab'); }}
        >
          <View style={styles.manageBtnLeft}>
            <Ionicons name="briefcase" size={22} color={colors.primary} style={styles.manageBtnIcon} />
            <View>
              <Text style={styles.manageBtnTitle}>Manage My Gigs</Text>
              <Text style={styles.manageBtnSub}>
                {profileBadgeCount > 0 ? `${profileBadgeCount} need${profileBadgeCount === 1 ? 's' : ''} attention` : 'Posted gigs & booking requests'}
              </Text>
            </View>
          </View>
          {profileBadgeCount > 0 && (
            <View style={styles.manageBadge}>
              <Text style={styles.manageBadgeText}>{profileBadgeCount}</Text>
            </View>
          )}
          <Text style={styles.manageBtnArrow}>›</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={styles.manageBtn}
        onPress={() => { haptic.medium(); navigation.navigate('PayoutSetup'); }}
      >
        <View style={styles.manageBtnLeft}>
          <Ionicons name="card" size={22} color={colors.primary} style={styles.manageBtnIcon} />
          <View>
            <Text style={styles.manageBtnTitle}>Payments</Text>
            <Text style={styles.manageBtnSub}>{paymentsSub}</Text>
          </View>
        </View>
        <Text style={styles.manageBtnArrow}>›</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.settingsBtn}
        onPress={() => navigation.navigate('Settings')}
      >
        <View style={styles.settingsBtnRow}>
          <Ionicons name="settings-outline" size={18} color={colors.textPrimary} style={{ marginRight: 8 }} />
          <Text style={styles.settingsBtnText}>Edit Profile & Settings</Text>
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.signOutBtn}
        onPress={() => { haptic.medium(); signOut(); }}
      >
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>

      <View style={{ height: 40 }} />
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

const styles = StyleSheet.create({
  manageBtn: {
    marginHorizontal: 16, marginTop: 16, borderRadius: 16,
    backgroundColor: colors.surface, padding: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1.5, borderColor: colors.primary + '40', ...shadows.sm,
  },
  manageBtnLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  manageBtnIcon: { fontSize: 22, marginRight: 12 },
  manageBtnTitle: { fontSize: 15, fontWeight: '800', color: colors.primary },
  manageBtnSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  manageBadge: {
    backgroundColor: colors.urgent, borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 3, marginRight: 8,
  },
  manageBadgeText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  manageBtnArrow: { fontSize: 22, color: colors.primary, fontWeight: '700' },
  settingsBtn: {
    marginHorizontal: 16, marginTop: 16, borderRadius: 14,
    paddingVertical: 14, alignItems: 'center',
    backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border,
  },
  settingsBtnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  settingsBtnText: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  signOutBtn: {
    marginHorizontal: 16, marginTop: 12, borderRadius: 14,
    paddingVertical: 14, alignItems: 'center',
    backgroundColor: colors.surface, borderWidth: 1.5, borderColor: '#FCA5A5',
  },
  signOutText: { fontSize: 15, fontWeight: '700', color: colors.urgent },
  container: { flex: 1, backgroundColor: colors.background },
  profileRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  avatar: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center', justifyContent: 'center', marginRight: 16,
  },
  avatarText: { color: '#fff', fontWeight: '900', fontSize: 26 },
  profileInfo: { flex: 1 },
  profileName: { fontSize: 22, fontWeight: '900', color: '#fff', marginBottom: 4 },
  profileSub: { fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 4 },
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
    backgroundColor: '#7C3AED',
    marginHorizontal: 16, marginTop: 14,
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
    backgroundColor: colors.surface, marginHorizontal: 16, marginTop: 14,
    borderRadius: 16, flexDirection: 'row', alignItems: 'center',
    paddingVertical: 16, borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: 18, fontWeight: '900', color: colors.textPrimary, marginBottom: 3 },
  statLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  statDiv: { width: 1, height: 36, backgroundColor: colors.border },
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
