import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import XPBar from './XPBar';
import ChallengeCard from './ChallengeCard';
import { isComplete, resetLabel } from '../lib/challenges';
import { colors, radii, shadows } from '../theme';

// Weekly goal bars. XP and challenges are separate exports above so the
// Progress pane can order everything by importance.
//
// The weekly-jobs math is reproduced VERBATIM on purpose: "Jobs Done" is derived
// from bookings that actually finished this week, never an apply-time counter that
// advanced the moment a gig was booked (CLAUDE.md documents that regression). Any
// paraphrase here silently reintroduces it.
// Split into three exports so the Progress pane can ORDER them by importance
// (money first, vanity metrics last) instead of taking one fixed blob.

export function XpCard() {
  const { xp, levelInfo } = useUser();
  return (
    <View style={styles.xpWrap}>
      <XPBar levelInfo={levelInfo} xp={xp} dark={false} />
    </View>
  );
}

// Finished challenges collapse into one line rather than three full cards
// shouting "Complete!" — with the reset spelled out, so a done challenge reads
// as "done for now", not as a badge you already earned.
export function ChallengesList() {
  const { challenges } = useUser();
  const all = challenges || [];
  const active = all.filter(c => !isComplete(c));
  const done = all.filter(isComplete);

  if (!all.length) return null;

  return (
    <View style={styles.challengesWrap}>
      {active.map(c => <ChallengeCard key={c.id} challenge={c} />)}
      {done.length > 0 && (
        <View style={styles.doneRow}>
          <Ionicons name="checkmark-circle" size={16} color={colors.success} />
          <Text style={styles.doneText} numberOfLines={2}>
            {done.length === all.length
              ? `All ${done.length} challenges done`
              : `${done.length} more done`}
            {' · '}
            {resetLabel(done[0].type)}
          </Text>
        </View>
      )}
    </View>
  );
}

export default function GoalsChallengesCard() {
  const {
    earningsWeek,
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
    <View style={styles.goalsCard}>
      <GoalBar label="Earnings" value={`$${earningsWeek}`} max={`$${weeklyEarningGoal}`} pct={earningPct} color={colors.primary} />
      <View style={{ height: 16 }} />
      <GoalBar label="Jobs done" value={`${weeklyJobsDone}`} max={`${weeklyJobsGoal} gigs`} pct={jobsPct} color={colors.primary} />
    </View>
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
  doneRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 12, paddingHorizontal: 14, marginTop: 4,
    backgroundColor: colors.surface, borderRadius: radii.md,
  },
  doneText: { flex: 1, fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  goalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  goalLabel: { fontSize: 13, fontWeight: '600', color: colors.textPrimary, flexShrink: 1, marginRight: 12 },
  goalValue: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, flexShrink: 0 },
  goalTrack: { height: 8, borderRadius: radii.pill, backgroundColor: colors.divider, overflow: 'hidden' },
  goalFill: { height: 8, borderRadius: radii.pill },
});
