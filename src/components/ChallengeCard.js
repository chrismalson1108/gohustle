import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, shadows } from '../theme';

export default function ChallengeCard({ challenge }) {
  const pct = Math.min(100, Math.round((challenge.progress / challenge.target) * 100));
  const done = pct >= 100;

  return (
    <View style={[styles.card, done && styles.done]}>
      <View style={styles.top}>
        <Ionicons name={challenge.ion || 'flag'} size={24} color={colors.textPrimary} style={styles.icon} />
        <View style={styles.info}>
          <Text style={styles.title} numberOfLines={1}>{challenge.title}</Text>
          <Text style={styles.desc} numberOfLines={2}>{challenge.description}</Text>
        </View>
        <View style={[styles.tag, done && styles.tagDone]}>
          <View style={styles.tagInner}>
            {done && <Ionicons name="checkmark" size={11} color={colors.success} style={{ marginRight: 3 }} />}
            <Text style={[styles.tagText, done && styles.tagTextDone]} numberOfLines={1}>
              {done ? 'Done' : challenge.type === 'daily' ? 'Daily' : 'Weekly'}
            </Text>
          </View>
        </View>
      </View>
      <View style={styles.progressRow}>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${pct}%` }, done && styles.fillDone]} />
        </View>
        <Text style={[styles.pct, done && { color: colors.success }]} numberOfLines={1}>{pct}%</Text>
      </View>
      <View style={styles.bottom}>
        <View style={styles.rewardRow}>
          <Ionicons name="trophy" size={12} color={colors.accentDeep} style={{ marginRight: 4 }} />
          <Text style={styles.reward} numberOfLines={1}>+{challenge.xpReward} XP</Text>
        </View>
        <Text style={[styles.count, done && { color: colors.success }]} numberOfLines={1}>
          {done ? 'Complete!' : `${challenge.progress} / ${challenge.target}`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: 16,
    marginBottom: 12,
    ...shadows.card,
  },
  done: { backgroundColor: colors.successLight },
  top: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 16 },
  icon: { marginRight: 12, marginTop: 1 },
  info: { flex: 1, marginRight: 8 },
  title: { fontSize: 15, fontWeight: '700', color: colors.textPrimary, marginBottom: 4, letterSpacing: -0.2 },
  desc: { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  tag: {
    backgroundColor: colors.background,
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: 'flex-start',
    flexShrink: 0,
  },
  tagInner: { flexDirection: 'row', alignItems: 'center' },
  tagDone: { backgroundColor: colors.surface },
  tagText: { fontSize: 11, fontWeight: '600', color: colors.textMuted },
  tagTextDone: { color: colors.success },
  progressRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  track: {
    flex: 1, height: 8, borderRadius: radii.pill,
    backgroundColor: colors.divider, overflow: 'hidden', marginRight: 8,
  },
  fill: { height: 8, borderRadius: radii.pill, backgroundColor: colors.primary },
  fillDone: { backgroundColor: colors.success },
  pct: { fontSize: 12, fontWeight: '600', color: colors.textSecondary, minWidth: 36, textAlign: 'right', flexShrink: 0 },
  bottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rewardRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 0, marginRight: 8 },
  reward: { fontSize: 12, color: colors.accentDeep, fontWeight: '600' },
  count: { fontSize: 12, color: colors.textSecondary, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
});
