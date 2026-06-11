import React, { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Switch, StyleSheet, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import GradientHeader from '../components/GradientHeader';
import BadgeGrid from '../components/BadgeGrid';
import XPBar from '../components/XPBar';
import RatingStars from '../components/RatingStars';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { useAuth } from '../context/AuthContext';
import { useHaptic } from '../hooks/useHaptic';
import { colors, gradients, shadows } from '../theme';

const REVIEWS = [
  { id: 'pr1', author: 'Karen O.', rating: 5, text: 'Alex was fast, polite, and did exactly what I asked. Will hire again!', date: '3 days ago' },
  { id: 'pr2', author: 'Linda H.', rating: 5, text: 'Showed up on time every week. Highly dependable.', date: '1 week ago' },
  { id: 'pr3', author: 'Tom W.', rating: 4, text: 'Good work, took a little longer than expected but quality was great.', date: '2 weeks ago' },
];

export default function ProfileScreen({ navigation }) {
  const {
    name, avatarInitial, role, rating, reviewCount,
    memberSince, levelInfo, xp, badges, earningsTotal,
    weeklyJobsDone, setRole, weeklyEarningGoal, weeklyJobsGoal, setGoals,
  } = useUser();
  const { postedJobs, bookedJobs, posterBookings, profileBadgeCount } = useJobs();
  const { signOut } = useAuth();
  const haptic = useHaptic();
  const [editGoals, setEditGoals] = useState(false);
  const [earGoal, setEarGoal] = useState(String(weeklyEarningGoal));
  const [jobGoal, setJobGoal] = useState(String(weeklyJobsGoal));

  const toggleRole = () => {
    haptic.medium();
    setRole(role === 'earner' ? 'poster' : 'earner');
  };

  const saveGoals = () => {
    const eg = parseInt(earGoal) || weeklyEarningGoal;
    const jg = parseInt(jobGoal) || weeklyJobsGoal;
    setGoals(eg, jg);
    setEditGoals(false);
    haptic.success();
    Alert.alert('Goals Updated! 🎯', 'Your weekly goals have been saved.');
  };

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      <GradientHeader colors={gradients.profile}>
        <View style={styles.profileRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{avatarInitial}</Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>{name}</Text>
            <RatingStars rating={rating} size={14} />
            <Text style={styles.profileSub}>{reviewCount} reviews · Member since {memberSince}</Text>
          </View>
        </View>
        <XPBar levelInfo={levelInfo} xp={xp} dark />
      </GradientHeader>

      <View style={styles.roleToggle}>
        <Text style={styles.roleLabel}>
          {role === 'earner' ? '🎓 Earner Mode' : '📋 Poster Mode'}
        </Text>
        <View style={styles.roleRight}>
          <Text style={styles.roleHint}>{role === 'earner' ? 'Find gigs' : 'Post gigs'}</Text>
          <Switch
            value={role === 'poster'}
            onValueChange={toggleRole}
            trackColor={{ false: colors.border, true: colors.primary }}
            thumbColor="#fff"
          />
        </View>
      </View>

      <View style={styles.statsRow}>
        <Stat label="Jobs Done" value={weeklyJobsDone} />
        <View style={styles.statDiv} />
        <Stat label="Total Earned" value={`$${earningsTotal.toLocaleString()}`} />
        <View style={styles.statDiv} />
        <Stat label="Avg Rating" value={rating.toFixed(1) + ' ★'} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Badges</Text>
        <BadgeGrid badges={badges} />
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Reviews I've Received</Text>
        </View>
        {REVIEWS.map(r => (
          <View key={r.id} style={styles.reviewCard}>
            <View style={styles.reviewTop}>
              <Text style={styles.reviewAuthor}>{r.author}</Text>
              <RatingStars rating={r.rating} size={12} />
              <Text style={styles.reviewDate}>{r.date}</Text>
            </View>
            <Text style={styles.reviewText}>{r.text}</Text>
          </View>
        ))}
      </View>

      {/* My Posted Gigs */}
      {postedJobs.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>My Posted Gigs</Text>
          {postedJobs.map(job => (
            <View key={job.id} style={styles.postedJobCard}>
              <View style={styles.postedJobInfo}>
                <Text style={styles.postedJobTitle} numberOfLines={1}>{job.title}</Text>
                <Text style={styles.postedJobMeta}>
                  {job.payType === 'hourly' ? `$${job.pay}/hr` : `$${job.pay} flat`}
                  {'  ·  '}{job.location}
                </Text>
              </View>
              <View style={styles.postedJobActions}>
                <TouchableOpacity
                  style={styles.editBtn}
                  onPress={() => navigation.navigate('EditJob', { jobId: job.id })}
                >
                  <Text style={styles.editBtnText}>✏️ Edit</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Manage Bookings — always show if there are any poster bookings */}
      {(postedJobs.length > 0 || posterBookings?.length > 0) && (
        <TouchableOpacity
          style={styles.manageBtn}
          onPress={() => navigation.navigate('ManageBookings')}
        >
          <View style={styles.manageBtnLeft}>
            <Text style={styles.manageBtnIcon}>📬</Text>
            <View>
              <Text style={styles.manageBtnTitle}>Manage Booking Requests</Text>
              <Text style={styles.manageBtnSub}>
                {profileBadgeCount > 0 ? `${profileBadgeCount} need${profileBadgeCount === 1 ? 's' : ''} attention` : 'View all incoming bookings'}
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
        style={styles.settingsBtn}
        onPress={() => navigation.navigate('Settings')}
      >
        <Text style={styles.settingsBtnText}>⚙️ Edit Profile & Settings</Text>
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
  reviewCard: {
    backgroundColor: colors.surface, borderRadius: 14,
    padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  reviewTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  reviewAuthor: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginRight: 8 },
  reviewDate: { fontSize: 11, color: colors.textMuted, marginLeft: 'auto' },
  reviewText: { fontSize: 13, color: colors.textSecondary, lineHeight: 20 },
});
