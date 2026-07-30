import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import XPBar from './XPBar';
import ChallengeCard from './ChallengeCard';
import { colors, radii, shadows } from '../theme';

// XP, weekly goals and challenges. Extracted from EarnScreen so the You tab's
// Progress pane renders exactly the same thing.
//
// The weekly-jobs math is reproduced VERBATIM on purpose: "Jobs Done" is derived
// from bookings that actually finished this week, never an apply-time counter that
// advanced the moment a gig was booked (CLAUDE.md documents that regression). Any
// paraphrase here silently reintroduces it.
export default function GoalsChallengesCard() {
  const {
    xp, levelInfo, earningsWeek, challenges,
    weeklyEarningGoal, weeklyJobsGoal,
  } = useUser();
  const { bookings } = useJobs();

  const earningPct = Math.min(1, earningsWeek / weeklyEarningGoal);

  // Week starts Monday.
  const weekStartMs = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  })();
  const weeklyJobsDone = (bookings || []).filter(b =>
    (b.status === 'completed' || b.status === 'verified')
    && b.completedAt && new Date(b.completedAt).getTime() >= weekStartMs
  ).length;
  const jobsPct = Math.min(1, weeklyJobsDone / weeklyJobsGoal);

  return (
    <>
      <View style={styles.xpWrap}>
        <XPBar levelInfo={levelInfo} xp={xp} dark={false} />
      </View>
      <View style={styles.goalsCard}>
        <GoalBar label="Earnings" value={`$${earningsWeek}`} max={`$${weeklyEarningGoal}`} pct={earningPct} color={colors.accent} />
        <View style={{ height: 16 }} />
        <GoalBar label="Jobs done" value={`${weeklyJobsDone}`} max={`${weeklyJobsGoal} gigs`} pct={jobsPct} color={colors.primary} />
      </View>
      <View style={styles.challengesWrap}>
        {(challenges || []).map(c => <ChallengeCard key={c.id} challenge={c} />)}
      </View>
    </>
  );
}

function GoalBar({ label, value, max, pct, color }) {
  return (
    <View>
      <View style={styles.goalHeader}>
        <Text style={styles.goalLabel} numberOfLines={1}>{label}</Text>
        <Text style={styles.goalValue} numberOfLines={1}>{value} / {max}</Text>
      </View>
      <View style={styles.goalTrack}>
        <View style={[styles.goalFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  xpWrap: {
    marginHorizontal: 16, marginTop: 12,
    backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16,
    ...shadows.card,
  },
  goalsCard: {
    marginHorizontal: 16, marginTop: 12, padding: 16,
    backgroundColor: colors.surface, borderRadius: radii.lg,
    ...shadows.card,
  },
  challengesWrap: { paddingHorizontal: 16, marginTop: 12 },
  goalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  goalLabel: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1, marginRight: 12 },
  goalValue: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, flexShrink: 0 },
  goalTrack: { height: 8, borderRadius: radii.pill, backgroundColor: colors.divider, overflow: 'hidden' },
  goalFill: { height: 8, borderRadius: radii.pill },
});
