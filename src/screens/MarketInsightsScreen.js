import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator,
  RefreshControl, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import ScreenHeader from '../components/ScreenHeader';
import JobsMap from '../components/JobsMap';
import { useJobs } from '../context/JobsContext';
import { supabase } from '../lib/supabase';
import { computeAreaInsights } from '../lib/insights';
import { colors, radii, shadows } from '../theme';

// Coerce a value (number or numeric string from Postgres) to a finite number or null.
function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(n) {
  if (n == null) return null;
  return `$${Math.round(n * 100) / 100}`;
}

// "Market Insights" — the Pro area heat-map. Calls the read-only `area_market_stats`
// aggregate RPC; on error/empty it falls back to computeAreaInsights() over the
// already-loaded public jobs feed (no tips/workers in the fallback).
export default function MarketInsightsScreen() {
  const { jobs } = useJobs();
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Fallback rows from the public jobs list, normalized to the card shape.
  const fallbackRows = useMemo(
    () =>
      computeAreaInsights(jobs).map((r) => ({
        area: r.area,
        jobCount: r.jobCount,
        avgPay: r.avgPay,
        topCategory: r.topCategory,
        avgTip: null,
        workerCount: null,
      })),
    [jobs],
  );

  const load = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc('area_market_stats');
      if (error || !Array.isArray(data) || data.length === 0) {
        setRows(fallbackRows);
      } else {
        setRows(
          data.map((d) => ({
            area: d.area,
            jobCount: Number(d.job_count) || 0,
            avgPay: num(d.avg_pay),
            topCategory: d.top_category,
            avgTip: num(d.avg_tip),
            workerCount: d.worker_count == null ? null : Number(d.worker_count),
          })),
        );
      }
    } catch {
      setRows(fallbackRows);
    } finally {
      setLoading(false);
    }
  }, [fallbackRows]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const display = rows ?? fallbackRows;
  const hasMapPins = jobs.some((j) => j.lat != null && j.lng != null);

  return (
    <View style={styles.container}>
      <ScreenHeader underNav>
        <View style={styles.topRow}>
          <View style={styles.topRowText}>
            <Text style={styles.title} numberOfLines={2}>Market Insights</Text>
            <Text style={styles.sub} numberOfLines={2}>Where the demand is — by area</Text>
          </View>
          <View style={styles.proPill}>
            <Ionicons name="sparkles" size={12} color={colors.accentDeep} />
            <Text style={styles.proText} numberOfLines={1}>Pro</Text>
          </View>
        </View>
      </ScreenHeader>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {hasMapPins && Platform.OS !== 'web' && (
          <View style={styles.mapWrap}>
            <JobsMap jobs={jobs} />
          </View>
        )}

        {loading && rows === null ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : display.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="bar-chart-outline" size={44} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>No market data yet</Text>
            <Text style={styles.emptyBody}>
              Once gigs are posted across a few areas, you'll see demand, pay, and worker density here.
            </Text>
          </View>
        ) : (
          display.map((r, i) => {
            return (
              <View key={r.area} style={styles.card}>
                <View style={styles.cardTop}>
                  <View style={styles.rankRow}>
                    <View style={styles.rank}>
                      <Text style={styles.rankText} numberOfLines={1}>{i + 1}</Text>
                    </View>
                    <Ionicons name="location-outline" size={15} color={colors.textMuted} />
                    <Text style={styles.area} numberOfLines={1}>{r.area}</Text>
                  </View>
                  <View style={styles.gigPill}>
                    <Text style={styles.gigPillText} numberOfLines={1}>
                      {r.jobCount} gig{r.jobCount !== 1 ? 's' : ''}
                    </Text>
                  </View>
                </View>

                <View style={styles.statsRow}>
                  {r.avgPay != null && (
                    <View style={styles.stat}>
                      <Ionicons name="trending-up" size={15} color={colors.accentDeep} />
                      <Text style={[styles.statText, styles.statTextMoney]} numberOfLines={1}>avg {money(r.avgPay)}</Text>
                    </View>
                  )}
                  {r.topCategory && (
                    <View style={styles.stat}>
                      <Ionicons name="pricetag-outline" size={15} color={colors.textMuted} />
                      <Text style={styles.statText} numberOfLines={1}>mostly {r.topCategory}</Text>
                    </View>
                  )}
                  {r.avgTip != null && (
                    <View style={styles.stat}>
                      <Ionicons name="cash-outline" size={15} color={colors.textMuted} />
                      <Text style={styles.statText} numberOfLines={1}>avg tip {money(r.avgTip)}</Text>
                    </View>
                  )}
                  {r.workerCount != null && (
                    <View style={styles.stat}>
                      <Ionicons name="people-outline" size={15} color={colors.textMuted} />
                      <Text style={styles.statText} numberOfLines={1}>
                        {r.workerCount} worker{r.workerCount !== 1 ? 's' : ''}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  topRowText: { flex: 1 },
  title: {
    fontSize: 24, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.4, lineHeight: 30,
  },
  sub: { fontSize: 13, color: colors.textSecondary, marginTop: 4, lineHeight: 18 },
  proPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', flexShrink: 0,
    backgroundColor: colors.accentLight, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radii.pill,
  },
  proText: { fontSize: 11, fontWeight: '700', color: colors.accentDeep, lineHeight: 15 },

  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 32 },
  mapWrap: { height: 240, borderRadius: radii.lg, overflow: 'hidden', marginBottom: 16, backgroundColor: colors.surface },
  center: { paddingVertical: 48, alignItems: 'center' },
  empty: { alignItems: 'center', paddingTop: 48, paddingHorizontal: 24 },
  emptyTitle: {
    fontSize: 16, fontWeight: '700', color: colors.textPrimary,
    marginTop: 12, textAlign: 'center', lineHeight: 22,
  },
  emptyBody: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginTop: 8, lineHeight: 20 },

  card: {
    backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, marginBottom: 12,
    ...shadows.card,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rankRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  rank: {
    minWidth: 26, height: 26, paddingHorizontal: 6, borderRadius: radii.pill,
    backgroundColor: colors.background, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  rankText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, lineHeight: 16 },
  area: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
  gigPill: {
    backgroundColor: colors.background, paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: radii.pill, alignSelf: 'flex-start', flexShrink: 0,
  },
  gigPillText: { fontSize: 12, fontWeight: '600', color: colors.textPrimary, lineHeight: 16 },

  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 12 },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  statText: { fontSize: 13, fontWeight: '500', color: colors.textSecondary, flexShrink: 1, lineHeight: 18 },
  statTextMoney: { fontWeight: '600', color: colors.textPrimary },
});
