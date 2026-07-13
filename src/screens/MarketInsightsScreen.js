import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator,
  RefreshControl, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import GradientHeader from '../components/GradientHeader';
import JobsMap from '../components/JobsMap';
import { useJobs } from '../context/JobsContext';
import { supabase } from '../lib/supabase';
import { computeAreaInsights } from '../lib/insights';
import { colors, gradients } from '../theme';
import { CATEGORY_COLORS } from '../data/mockData';

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
      <GradientHeader colors={gradients.primary} topInset={false}>
        <View style={styles.topRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Market Insights</Text>
            <Text style={styles.sub}>Where the demand is — by area</Text>
          </View>
          <View style={styles.proPill}>
            <Ionicons name="sparkles" size={12} color={colors.textPrimary} />
            <Text style={styles.proText}>PRO</Text>
          </View>
        </View>
      </GradientHeader>

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
            const catColor = (r.topCategory && CATEGORY_COLORS[r.topCategory]) || colors.primary;
            return (
              <View key={r.area} style={styles.card}>
                <View style={styles.cardTop}>
                  <View style={styles.rankRow}>
                    <View style={styles.rank}>
                      <Text style={styles.rankText}>{i + 1}</Text>
                    </View>
                    <Ionicons name="location-outline" size={15} color={colors.textMuted} />
                    <Text style={styles.area} numberOfLines={1}>{r.area}</Text>
                  </View>
                  <View style={styles.gigPill}>
                    <Text style={styles.gigPillText}>
                      {r.jobCount} gig{r.jobCount !== 1 ? 's' : ''}
                    </Text>
                  </View>
                </View>

                <View style={styles.statsRow}>
                  {r.avgPay != null && (
                    <View style={styles.stat}>
                      <Ionicons name="trending-up" size={15} color={colors.accent} />
                      <Text style={styles.statText}>avg {money(r.avgPay)}</Text>
                    </View>
                  )}
                  {r.topCategory && (
                    <View style={styles.stat}>
                      <View style={[styles.dot, { backgroundColor: catColor }]} />
                      <Text style={styles.statText}>mostly {r.topCategory}</Text>
                    </View>
                  )}
                  {r.avgTip != null && (
                    <View style={styles.stat}>
                      <Ionicons name="cash-outline" size={15} color={colors.gold} />
                      <Text style={styles.statText}>avg tip {money(r.avgTip)}</Text>
                    </View>
                  )}
                  {r.workerCount != null && (
                    <View style={styles.stat}>
                      <Ionicons name="people-outline" size={15} color={colors.textMuted} />
                      <Text style={styles.statText}>
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
  title: { fontSize: 24, fontWeight: '900', color: '#fff' },
  sub: { fontSize: 13, color: 'rgba(255,255,255,0.75)', marginTop: 2 },
  proPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.gold, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
  },
  proText: { fontSize: 11, fontWeight: '900', color: colors.textPrimary, letterSpacing: 0.5 },

  content: { padding: 16, paddingBottom: 32 },
  mapWrap: { height: 240, borderRadius: 20, overflow: 'hidden', marginBottom: 16 },
  center: { paddingVertical: 48, alignItems: 'center' },
  empty: { alignItems: 'center', paddingTop: 48, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: colors.textPrimary, marginTop: 12 },
  emptyBody: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginTop: 6 },

  card: {
    backgroundColor: colors.surface, borderRadius: 16, padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  rankRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  rank: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center',
  },
  rankText: { fontSize: 13, fontWeight: '900', color: colors.primary },
  area: { fontSize: 15, fontWeight: '800', color: colors.textPrimary, flexShrink: 1 },
  gigPill: { backgroundColor: colors.primaryLight, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  gigPillText: { fontSize: 12, fontWeight: '900', color: colors.primary },

  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 12 },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  dot: { width: 10, height: 10, borderRadius: 5 },
});
