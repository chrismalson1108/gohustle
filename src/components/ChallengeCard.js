import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, shadows } from '../theme';

export default function ChallengeCard({ challenge }) {
  const pct = Math.min(100, Math.round((challenge.progress / challenge.target) * 100));
  const done = pct >= 100;

  return (
    <View style={[styles.card, done && styles.done]}>
      <View style={styles.top}>
        <Text style={styles.icon}>{challenge.icon}</Text>
        <View style={styles.info}>
          <Text style={styles.title}>{challenge.title}</Text>
          <Text style={styles.desc}>{challenge.description}</Text>
        </View>
        <View style={[styles.tag, done && styles.tagDone]}>
          <Text style={[styles.tagText, done && styles.tagTextDone]}>
            {done ? '✓ Done' : challenge.type === 'daily' ? 'Daily' : 'Weekly'}
          </Text>
        </View>
      </View>
      <View style={styles.progressRow}>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${pct}%` }, done && styles.fillDone]} />
        </View>
        <Text style={[styles.pct, done && { color: colors.accent }]}>{pct}%</Text>
      </View>
      <View style={styles.bottom}>
        <Text style={styles.reward}>🏆 +{challenge.xpReward} XP</Text>
        <Text style={[styles.count, done && { color: colors.accent, fontWeight: '700' }]}>
          {done ? 'Complete!' : `${challenge.progress} / ${challenge.target}`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1.5,
    borderColor: colors.border,
    ...shadows.sm,
  },
  done: { borderColor: colors.accent, backgroundColor: '#F0FDF4' },
  top: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 14 },
  icon: { fontSize: 26, marginRight: 12, marginTop: 1 },
  info: { flex: 1 },
  title: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
  desc: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  tag: {
    backgroundColor: colors.primaryLight,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 8,
  },
  tagDone: { backgroundColor: '#DCFCE7' },
  tagText: { fontSize: 10, fontWeight: '700', color: colors.primary },
  tagTextDone: { color: colors.success },
  progressRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  track: {
    flex: 1, height: 8, borderRadius: 4,
    backgroundColor: colors.divider, overflow: 'hidden', marginRight: 8,
  },
  fill: { height: 8, borderRadius: 4, backgroundColor: colors.primary },
  fillDone: { backgroundColor: colors.accent },
  pct: { fontSize: 12, fontWeight: '700', color: colors.primary, width: 34, textAlign: 'right' },
  bottom: { flexDirection: 'row', justifyContent: 'space-between' },
  reward: { fontSize: 12, color: colors.gold, fontWeight: '600' },
  count: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
});
