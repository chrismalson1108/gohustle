import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { computeEarnerInsights } from '../lib/insights';
import { formatMoney } from '../lib/finance';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import MoneyGoalCard from './MoneyGoalCard';
import { colors, radii, shadows } from '../theme';

// Derivations live here rather than being passed in, so every mount stays in sync.
// Split so the Progress pane can order by importance: money near the top,
// insights lower down.
export function EarningsTiles() {
  const { earningsToday, earningsWeek, earningsTotal } = useUser();
  const { bookings } = useJobs();

  // Avg $/job over verified (paid-out) bookings — earnings only accrue on verify.
  const completedCount = (bookings || []).filter(b => b.status === 'verified').length;
  const avgPerJob = completedCount ? earningsTotal / completedCount : 0;

  return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Earnings</Text>
        <View style={styles.row}>
          {[
            { label: 'Today',     value: formatMoney(earningsToday) },
            { label: 'This week', value: formatMoney(earningsWeek) },
            { label: 'All time',  value: formatMoney(earningsTotal) },
            { label: 'Avg/job',   value: completedCount ? formatMoney(Math.round(avgPerJob)) : '—' },
          ].map(s => (
            <View key={s.label} style={styles.tile}>
              {/* Four tiles share the row, so a full earnings total ("$2,640.50")
                  is wider than its quarter and was truncating to "$2,640…" —
                  which reads as a different, smaller number. Shrink to fit
                  instead of clipping; the floor still keeps it legible. */}
              <Text
                style={styles.tileVal}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.6}
              >
                {s.value}
              </Text>
              <Text style={styles.tileLabel} numberOfLines={1}>{s.label}</Text>
            </View>
          ))}
        </View>
      </View>
  );
}

export function InsightsCard() {
  const { bookings } = useJobs();
  const insights = computeEarnerInsights(bookings);
  if (!insights || insights.jobCount === 0) return null;
  return (
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
