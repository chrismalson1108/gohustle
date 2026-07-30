import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { computeEarnerInsights } from '../lib/insights';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import MoneyGoalCard from './MoneyGoalCard';
import { colors, radii, shadows } from '../theme';

// Money summary: goal card, the four earnings tiles, and personal insights.
// Extracted from EarnScreen so the You tab's Progress pane renders the identical UI.
// Derivations live here rather than being passed in, so both mounts stay in sync.
export default function MonthSummaryCard({ navigation }) {
  const { earningsToday, earningsWeek, earningsTotal } = useUser();
  const { bookings } = useJobs();

  // Avg $/job over verified (paid-out) bookings — earnings only accrue on verify.
  const completedCount = (bookings || []).filter(b => b.status === 'verified').length;
  const avgPerJob = completedCount ? earningsTotal / completedCount : 0;
  const insights = computeEarnerInsights(bookings);

  return (
    <>
      <MoneyGoalCard navigation={navigation} />

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Earnings</Text>
        <View style={styles.row}>
          {[
            { label: 'Today',     value: `$${earningsToday}` },
            { label: 'This week', value: `$${earningsWeek}` },
            { label: 'All time',  value: `$${earningsTotal.toLocaleString()}` },
            { label: 'Avg/job',   value: completedCount ? `$${Math.round(avgPerJob).toLocaleString()}` : '—' },
          ].map(s => (
            <View key={s.label} style={styles.tile}>
              <Text style={styles.tileVal} numberOfLines={1}>{s.value}</Text>
              <Text style={styles.tileLabel} numberOfLines={1}>{s.label}</Text>
            </View>
          ))}
        </View>
      </View>

      {insights && insights.jobCount > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Your insights</Text>
          <View style={styles.insightsRow}>
            <InsightTile icon="location-outline" label="Top area" value={insights.topArea?.label || '—'} />
            <InsightTile icon="calendar-outline" label="Busiest" value={insights.busiestDay?.label || '—'} />
            <InsightTile
              icon="cash-outline"
              label="Best day"
              value={insights.mostProfitableDay
                ? `${insights.mostProfitableDay.label} ($${Math.round(insights.mostProfitableDay.total).toLocaleString()})`
                : '—'}
            />
          </View>
        </View>
      )}
    </>
  );
}

function InsightTile({ icon, label, value }) {
  return (
    <View style={styles.insightTile}>
      <Ionicons name={icon} size={16} color={colors.textSecondary} style={{ marginBottom: 4 }} />
      <Text style={styles.insightLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.insightValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16, marginTop: 12,
    backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16,
    ...shadows.card,
  },
  cardTitle: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 12 },
  row: { flexDirection: 'row', gap: 8 },
  tile: {
    flex: 1, backgroundColor: colors.background, borderRadius: radii.md,
    paddingVertical: 12, paddingHorizontal: 4, alignItems: 'center',
  },
  tileVal: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  tileLabel: { fontSize: 11, color: colors.textMuted, marginTop: 4 },
  insightsRow: { flexDirection: 'row', gap: 8 },
  insightTile: {
    flex: 1, backgroundColor: colors.background,
    borderRadius: radii.md, paddingVertical: 12, paddingHorizontal: 12,
  },
  insightLabel: { fontSize: 11, fontWeight: '500', color: colors.textMuted, marginBottom: 4 },
  insightValue: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
});
