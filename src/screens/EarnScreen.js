import React from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import GradientHeader from '../components/GradientHeader';
import ChallengeCard from '../components/ChallengeCard';
import JobCard from '../components/JobCard';
import XPBar from '../components/XPBar';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { colors, gradients, shadows } from '../theme';

export default function EarnScreen({ navigation }) {
  const {
    earningsToday, earningsWeek, earningsTotal,
    streakDays, levelInfo, xp, challenges,
    weeklyEarningGoal, weeklyJobsGoal, weeklyJobsDone,
  } = useUser();
  const { bookedJobs, bookings } = useJobs();

  const earningPct = Math.min(1, earningsWeek / weeklyEarningGoal);
  const jobsPct    = Math.min(1, weeklyJobsDone / weeklyJobsGoal);

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      <GradientHeader colors={gradients.earn}>
        <Text style={styles.screenTitle}>Hustle Dashboard 💰</Text>
        <LinearGradient colors={['rgba(255,255,255,0.18)', 'rgba(255,255,255,0.08)']} style={styles.earningsCard}>
          <View style={styles.earningsRow}>
            <EarStat label="Today" value={`$${earningsToday}`} />
            <View style={styles.divider} />
            <EarStat label="This Week" value={`$${earningsWeek}`} highlight />
            <View style={styles.divider} />
            <EarStat label="All Time" value={`$${earningsTotal.toLocaleString()}`} />
          </View>
        </LinearGradient>
        <View style={styles.streakLevelRow}>
          <View style={styles.streakPill}>
            <Text style={styles.streakFire}>🔥</Text>
            <Text style={styles.streakText}>{streakDays}-day streak</Text>
          </View>
          <View style={styles.xpWrap}>
            <XPBar levelInfo={levelInfo} xp={xp} dark />
          </View>
        </View>
      </GradientHeader>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Weekly Goals</Text>
        <View style={[styles.card, { padding: 16 }]}>
          <GoalBar label="Earnings" value={`$${earningsWeek}`} max={`$${weeklyEarningGoal}`} pct={earningPct} color={colors.accent} />
          <View style={{ height: 14 }} />
          <GoalBar label="Jobs Done" value={`${weeklyJobsDone}`} max={`${weeklyJobsGoal} gigs`} pct={jobsPct} color={colors.primary} />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Active Challenges</Text>
        {challenges.map(c => <ChallengeCard key={c.id} challenge={c} />)}
      </View>

      {bookedJobs.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Your Booked Gigs</Text>
          {bookedJobs.map(j => {
            const booking = bookings.find(b => b.jobId === j.id);
            return (
              <View key={j.id}>
                <JobCard job={j} onPress={() => navigation.navigate('JobDetail', { jobId: j.id })} />
                {booking && (booking.slotLabel || booking.counterOffer) && (
                  <View style={styles.bookingMeta}>
                    {booking.slotLabel && (
                      <View style={styles.bookingRow}>
                        <Text style={styles.bookingIcon}>📅</Text>
                        <Text style={styles.bookingText}>{booking.slotLabel}</Text>
                      </View>
                    )}
                    {booking.counterOffer && (
                      <View style={styles.bookingRow}>
                        <Text style={styles.bookingIcon}>💬</Text>
                        <Text style={styles.bookingText}>
                          Counter-offer: <Text style={styles.bookingBold}>
                            ${booking.counterOffer}{j.payType === 'hourly' ? '/hr' : ' flat'}
                          </Text> (listed ${j.pay}{j.payType === 'hourly' ? '/hr' : ''})
                        </Text>
                      </View>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}

      {bookedJobs.length === 0 && (
        <View style={styles.emptyGigs}>
          <Text style={styles.emptyIcon}>📋</Text>
          <Text style={styles.emptyTitle}>No booked gigs yet</Text>
          <Text style={styles.emptyText}>Browse the Home tab and book your first gig to start earning!</Text>
        </View>
      )}
      <View style={{ height: 30 }} />
    </ScrollView>
  );
}

function EarStat({ label, value, highlight }) {
  return (
    <View style={styles.earStat}>
      <Text style={[styles.earValue, highlight && styles.earValueHL]}>{value}</Text>
      <Text style={styles.earLabel}>{label}</Text>
    </View>
  );
}

function GoalBar({ label, value, max, pct, color }) {
  return (
    <View>
      <View style={styles.goalHeader}>
        <Text style={styles.goalLabel}>{label}</Text>
        <Text style={[styles.goalValue, { color }]}>{value} / {max}</Text>
      </View>
      <View style={styles.goalTrack}>
        <View style={[styles.goalFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  screenTitle: { fontSize: 22, fontWeight: '800', color: '#fff', marginBottom: 16 },
  earningsCard: { borderRadius: 18, padding: 20, marginBottom: 16 },
  earningsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  earStat: { alignItems: 'center', flex: 1 },
  earValue: { fontSize: 20, fontWeight: '800', color: '#fff', marginBottom: 2 },
  earValueHL: { fontSize: 26 },
  earLabel: { fontSize: 11, color: 'rgba(255,255,255,0.7)', fontWeight: '600' },
  divider: { width: 1, height: 40, backgroundColor: 'rgba(255,255,255,0.2)' },
  streakLevelRow: { flexDirection: 'row', alignItems: 'center' },
  streakPill: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7,
    marginRight: 12,
  },
  streakFire: { fontSize: 16, marginRight: 5 },
  streakText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  xpWrap: { flex: 1 },
  section: { paddingHorizontal: 16, marginTop: 24 },
  sectionTitle: {
    fontSize: 13, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 12,
  },
  card: {
    backgroundColor: colors.surface, borderRadius: 18,
    borderWidth: 1, borderColor: colors.border,
    ...shadows.sm,
  },
  goalHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  goalLabel: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  goalValue: { fontSize: 13, fontWeight: '700' },
  goalTrack: { height: 10, borderRadius: 5, backgroundColor: colors.divider, overflow: 'hidden' },
  goalFill: { height: 10, borderRadius: 5 },
  bookingMeta: {
    backgroundColor: colors.accentLight, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 10,
    marginTop: -6, marginBottom: 10,
  },
  bookingRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 4 },
  bookingIcon: { fontSize: 13, marginRight: 8, marginTop: 1 },
  bookingText: { fontSize: 13, color: colors.success, flex: 1, lineHeight: 19 },
  bookingBold: { fontWeight: '800' },
  emptyGigs: { alignItems: 'center', padding: 40 },
  emptyIcon: { fontSize: 44, marginBottom: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary, marginBottom: 8 },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
});
