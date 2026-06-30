import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { computeGoalPlan, rankGigsForGoal } from '../lib/finance';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { useAuth } from '../context/AuthContext';
import { colors, shadows } from '../theme';

const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString()}`;

const PACE = {
  reached: { label: 'Goal reached 🎉', bg: colors.successLight, fg: colors.success },
  ahead:   { label: 'Ahead of pace',   bg: colors.successLight, fg: colors.success },
  onTrack: { label: 'On track',        bg: colors.primaryLight, fg: colors.primary },
  behind:  { label: 'Behind pace',     bg: colors.urgentLight,  fg: colors.urgent },
  unset:   { label: 'Set a goal',      bg: colors.divider,      fg: colors.textMuted },
};

function isThisMonth(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

export default function MoneyGoalCard({ navigation }) {
  const { monthlyEarningGoal, skills, setMonthlyGoal, showToast } = useUser();
  const { bookings, jobs } = useJobs();
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(monthlyEarningGoal || 1000));

  const { plan, picks } = useMemo(() => {
    const paid = (bookings || []).filter(
      (b) => (b.status === 'verified' || b.status === 'completed') && isThisMonth(b.completedAt),
    );
    const vals = paid.map((b) => b.counterOffer ?? b.job?.pay ?? 0).filter((v) => v > 0);
    const earned = vals.reduce((s, v) => s + v, 0);
    let avg = vals.length ? earned / vals.length : 0;
    if (!avg) {
      const anyPaid = (bookings || [])
        .filter((b) => b.status === 'verified' || b.status === 'completed')
        .map((b) => b.counterOffer ?? b.job?.pay ?? 0)
        .filter((v) => v > 0);
      avg = anyPaid.length ? anyPaid.reduce((s, v) => s + v, 0) / anyPaid.length : 40;
    }
    const p = computeGoalPlan({ monthlyGoal: monthlyEarningGoal, earnedThisMonth: earned, avgGigValue: avg, gigsThisMonth: vals.length });
    const open = (jobs || []).filter((j) => j.status === 'open' && j.posterId !== user?.id);
    const ranked = rankGigsForGoal(open, { skills, remaining: p.remaining }).slice(0, 3);
    return { plan: p, picks: ranked };
  }, [bookings, jobs, monthlyEarningGoal, skills, user?.id]);

  const pace = PACE[plan.status] || PACE.unset;
  const pct = Math.round(plan.pctComplete * 100);

  const save = () => {
    const n = Math.max(0, Math.round(Number(draft) || 0));
    if (n > 0) {
      setMonthlyGoal(n);
      showToast?.({ icon: '🎯', title: 'Goal updated', message: `Aiming for ${money(n)} this month.` });
    }
    setEditing(false);
  };

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={styles.iconCircle}>
          <Ionicons name="flag" size={18} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Money goal</Text>
          <Text style={styles.sub}>{plan.daysLeft} days left this month</Text>
        </View>
        <View style={[styles.pacePill, { backgroundColor: pace.bg }]}>
          <Text style={[styles.paceText, { color: pace.fg }]}>{pace.label}</Text>
        </View>
      </View>

      {editing ? (
        <View style={styles.editRow}>
          <Text style={styles.editLabel}>Monthly goal $</Text>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            keyboardType="number-pad"
            autoFocus
            style={styles.input}
            onSubmitEditing={save}
          />
          <TouchableOpacity style={styles.saveBtn} onPress={save}>
            <Ionicons name="checkmark" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.goalRow}
          onPress={() => { setDraft(String(monthlyEarningGoal || 1000)); setEditing(true); }}
        >
          <Text style={styles.goalEarned}>{money(plan.earned)}</Text>
          <Text style={styles.goalOf}>of {money(plan.goal)}</Text>
          <Ionicons name="pencil" size={13} color={colors.textMuted} />
        </TouchableOpacity>
      )}

      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${Math.min(100, pct)}%` }]} />
      </View>

      <View style={styles.statsRow}>
        {[
          { label: 'Left to go', value: money(plan.remaining) },
          { label: 'Gigs to go', value: plan.gigsNeeded == null ? '—' : String(plan.gigsNeeded) },
          { label: 'Per week', value: money(plan.perWeekNeeded) },
        ].map((s) => (
          <View key={s.label} style={styles.stat}>
            <Text style={styles.statVal}>{s.value}</Text>
            <Text style={styles.statLabel}>{s.label}</Text>
          </View>
        ))}
      </View>

      {picks.length > 0 && plan.status !== 'reached' && (
        <View style={styles.picks}>
          <Text style={styles.picksTitle}>📈 Best gigs to hit your goal</Text>
          {picks.map((j) => (
            <TouchableOpacity
              key={j.id}
              style={styles.pickRow}
              onPress={() => navigation?.navigate('JobDetail', { jobId: j.id })}
            >
              <Text style={styles.pickTitle} numberOfLines={1}>{j.title}</Text>
              <Text style={styles.pickPay}>{money(j.pay)}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 18, padding: 16, marginHorizontal: 16, marginTop: 14, ...shadows.card },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconCircle: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 15, fontWeight: '900', color: colors.textPrimary },
  sub: { fontSize: 12, color: colors.textMuted },
  pacePill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  paceText: { fontSize: 11, fontWeight: '800' },
  goalRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 12 },
  goalEarned: { fontSize: 24, fontWeight: '900', color: colors.textPrimary },
  goalOf: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  editLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  input: { width: 100, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7, fontSize: 14, fontWeight: '700', color: colors.textPrimary, backgroundColor: colors.background },
  saveBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  bar: { height: 10, borderRadius: 5, backgroundColor: colors.divider, overflow: 'hidden', marginTop: 10 },
  barFill: { height: '100%', borderRadius: 5, backgroundColor: colors.primary },
  statsRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  stat: { flex: 1, backgroundColor: colors.background, borderRadius: 12, paddingVertical: 8, alignItems: 'center' },
  statVal: { fontSize: 15, fontWeight: '900', color: colors.textPrimary },
  statLabel: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  picks: { marginTop: 12, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 12 },
  picksTitle: { fontSize: 12, fontWeight: '800', color: colors.textSecondary, marginBottom: 8 },
  pickRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, backgroundColor: colors.background, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 6 },
  pickTitle: { flex: 1, fontSize: 13.5, fontWeight: '600', color: colors.textPrimary },
  pickPay: { fontSize: 13.5, fontWeight: '900', color: colors.primary },
});
