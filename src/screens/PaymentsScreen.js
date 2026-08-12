// ─────────────────────────────────────────────────────────────────────────────
// Every transaction, both sides. The statement the app never had.
//
// What the competitors get right and this borrows:
//   • Uber/Lyft — the money's STATE is on screen, not inferred. "In escrow" vs
//     "released" is the question people open the app to answer.
//   • DoorDash — a per-item breakdown that adds up to the deposit, so a user can
//     reconcile against their bank instead of trusting a total.
//   • TaskRabbit — the client sees an invoice, not just the worker seeing a payout.
//     A poster with no record of what they were charged is the half everyone forgets.
//
// And the one they get wrong, which is not repeated here: showing a confident
// "arrives Tuesday" the platform cannot actually know. Capture moves money to the
// earner's Stripe account; Stripe pays out on that account's schedule, which we do
// not store. So this points at the payout account rather than inventing a date.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, SectionList, TouchableOpacity, StyleSheet, Modal, ScrollView,
  ActivityIndicator, RefreshControl, Share, Linking, TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import ScreenHeader from '../components/ScreenHeader';
import { useAuth } from '../context/AuthContext';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import {
  fetchLedger, byMonth, ledgerCsv, paymentState, fetchPayouts,
  RANGES, STATUS_FILTERS, filterEntries, stats, monthlyTotals,
} from '../lib/payments';
import { stripeEdge } from '../lib/stripeClient';
import { colors, radii, shadows } from '../theme';

const fmt = (c) => `$${(Math.abs(c) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shortDate = (v) => (v ? new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—');
const longDate = (v) =>
  v ? new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

const TONE = {
  good:  { bg: colors.successLight, fg: colors.success },
  hold:  { bg: colors.warningLight, fg: colors.warningDeep },
  bad:   { bg: colors.urgentLight, fg: colors.urgent },
  muted: { bg: colors.border, fg: colors.textSecondary },
};

export default function PaymentsScreen({ navigation, route }) {
  const { user } = useAuth();
  const { showToast } = useUser();
  const haptic = useHaptic();

  const [side, setSide] = useState(route?.params?.side === 'poster' ? 'poster' : 'earner');
  // Landing a pure poster on an empty "Earnings" tab reads as "we lost your money".
  // Auto-pick the side they actually have history on, but only ONCE and only before
  // they have touched the control — after that the choice is theirs.
  const chosenRef = useRef(Boolean(route?.params?.side));
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [payouts, setPayouts] = useState(null);
  const [payoutsOpen, setPayoutsOpen] = useState(false);
  const [range, setRange] = useState('ytd');
  const [statusKey, setStatusKey] = useState('all');
  const [query, setQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  const load = useCallback(async () => {
    if (!user?.id) return;
    try {
      setError(null);
      const rows = await fetchLedger(user.id);
      setEntries(rows);
      // Best-effort: the ledger is the screen's job, and a payouts hiccup must not
      // make it look like the transactions failed to load.
      fetchPayouts(user.id).then(setPayouts).catch(() => setPayouts([]));
      if (!chosenRef.current) {
        chosenRef.current = true;
        const earner = rows.filter((r) => r.side === 'earner').length;
        if (!earner && rows.some((r) => r.side === 'poster')) setSide('poster');
      }
    } catch (e) {
      // Money is the one screen where a silent empty state is dangerous: "no
      // transactions" and "we could not load your transactions" must never look the
      // same, or a user concludes their money vanished.
      setError(e?.message || 'Could not load your transactions.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const mine = useMemo(
    () => filterEntries(entries, { side, range, status: statusKey, query }),
    [entries, side, range, statusKey, query],
  );
  const sections = useMemo(() => byMonth(mine), [mine]);
  const sum = useMemo(() => stats(mine), [mine]);
  const trend = useMemo(() => monthlyTotals(mine, 6), [mine]);
  const otherSideCount = entries.filter((e) => e.side !== side).length;
  const rangeLabel = RANGES.find((r) => r.key === range)?.label ?? '';
  const filtered = statusKey !== 'all' || query.trim().length > 0;

  const exportCsv = async () => {
    if (!mine.length) return;
    haptic.light?.();
    try {
      await Share.share({
        title: `GoHustlr ${side === 'earner' ? 'earnings' : 'spending'} statement`,
        message: ledgerCsv(entries, side),
      });
    } catch (_) {}
  };

  // Opens OUR record first. It used to jump straight to Stripe's hosted dashboard,
  // which meant leaving the app and signing in again to answer "did it land yet".
  // Stripe stays one tap deeper for the things only it can show (bank details,
  // full history).
  const openPayoutAccount = () => { haptic.light?.(); setPayoutsOpen(true); };

  const openStripeDashboard = async () => {
    haptic.light?.();
    try {
      const { url } = await stripeEdge.getPayoutLoginLink();
      if (url) return Linking.openURL(url);
      showToast({ icon: '💳', title: 'Set up payouts first', message: 'Add a payout account to see bank deposits.' });
    } catch (_) {
      showToast({ icon: '⚠️', title: 'Could not open', message: 'Try again from Payments & payouts.' });
    }
  };

  const renderRow = ({ item }) => {
    const st = paymentState(item.status, item.side);
    const tone = TONE[st.tone] ?? TONE.muted;
    return (
      <TouchableOpacity
        style={styles.row}
        activeOpacity={0.7}
        onPress={() => { haptic.light?.(); setDetail(item); }}
      >
        <View style={{ flex: 1, paddingRight: 10 }}>
          <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
          <View style={styles.rowMeta}>
            <Text style={styles.rowDate}>{shortDate(item.at)}</Text>
            <View style={[styles.chip, { backgroundColor: tone.bg }]}>
              <Text style={[styles.chipText, { color: tone.fg }]}>{st.label}</Text>
            </View>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text
            style={[
              styles.rowAmount,
              item.status === 'cancelled' || item.status === 'failed' ? styles.rowAmountVoid : null,
            ]}
          >
            {item.side === 'earner' ? '+' : '−'}{fmt(item.netCents)}
          </Text>
          {item.refundedCents > 0 ? (
            <Text style={styles.rowSub}>{fmt(item.refundedCents)} refunded</Text>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.screen}>
      <ScreenHeader topInset={false}>
        {/* No title here on purpose — the native nav bar already says
            "Transactions". Printing it twice was just noise in the space the
            controls need. */}
        <View style={styles.segments}>
          {[
            { k: 'earner', label: 'Earnings' },
            { k: 'poster', label: 'Spending' },
          ].map((s) => (
            <TouchableOpacity
              key={s.k}
              style={[styles.segment, side === s.k && styles.segmentOn]}
              onPress={() => { haptic.light?.(); chosenRef.current = true; setSide(s.k); }}
            >
              <Text style={[styles.segmentText, side === s.k && styles.segmentTextOn]}>{s.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── Time range. First control because every number below is scoped by
            it, and "earned this year" vs "earned in 30 days" are different
            questions people ask in the same session. ── */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {RANGES.map((r) => (
            <TouchableOpacity
              key={r.key}
              style={[styles.chip2, range === r.key && styles.chip2On]}
              onPress={() => { haptic.selection?.(); setRange(r.key); }}
            >
              <Text style={[styles.chip2Text, range === r.key && styles.chip2TextOn]}>{r.label}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={[styles.chip2, showSearch && styles.chip2On]}
            onPress={() => { haptic.selection?.(); setShowSearch((v) => !v); if (showSearch) setQuery(''); }}
          >
            <Ionicons name="search" size={14} color={showSearch ? '#fff' : colors.textSecondary} />
          </TouchableOpacity>
        </ScrollView>

        {showSearch ? (
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Search by gig"
            placeholderTextColor={colors.textMuted}
            autoFocus
            returnKeyType="search"
          />
        ) : null}

        {/* ── Status. Deliberately separate from the time range: "show me what is
            still in escrow" and "show me last quarter" compose. ── */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {STATUS_FILTERS.map((f) => (
            <TouchableOpacity
              key={f.key}
              style={[styles.chip2, statusKey === f.key && styles.chip2On]}
              onPress={() => { haptic.selection?.(); setStatusKey(f.key); }}
            >
              <Text style={[styles.chip2Text, statusKey === f.key && styles.chip2TextOn]}>{f.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </ScreenHeader>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(i) => i.id}
          renderItem={renderRow}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />
          }
          ListHeaderComponent={
            <View style={styles.summaryWrap}>
              {error ? (
                <View style={styles.errorCard}>
                  <Ionicons name="alert-circle" size={18} color={colors.urgent} />
                  <Text style={styles.errorText}>{error}</Text>
                  <TouchableOpacity onPress={load}><Text style={styles.retry}>Retry</Text></TouchableOpacity>
                </View>
              ) : null}

              {/* ── Headline: the one number, and what is still owed ── */}
              <View style={styles.summary}>
                <View style={styles.summaryCell}>
                  <Text style={styles.summaryLabel}>
                    {side === 'earner' ? 'Earned' : 'Spent'} · {rangeLabel}
                  </Text>
                  <Text style={styles.summaryValue}>{fmt(sum.netCents)}</Text>
                  <Text style={styles.summaryHint}>
                    {sum.settledCount} completed{sum.avgCents > 0 ? ` · ${fmt(sum.avgCents)} avg` : ''}
                  </Text>
                </View>
                <View style={styles.summaryDivider} />
                <View style={styles.summaryCell}>
                  <Text style={styles.summaryLabel}>{side === 'earner' ? 'In escrow' : 'On hold'}</Text>
                  <Text style={[styles.summaryValue, { color: colors.warningDeep }]}>{fmt(sum.heldCents)}</Text>
                  <Text style={styles.summaryHint}>
                    {side === 'earner' ? 'released on verify' : 'not charged yet'}
                  </Text>
                </View>
              </View>

              {/* ── Trend. Six months of settled money, so the shape of the year is
                  visible without doing arithmetic on a list. Bars are relative to the
                  best month; an all-zero stretch stays flat rather than being scaled
                  up into a misleading peak. ── */}
              {trend.some((m) => m.cents > 0) ? (
                <View style={styles.trend}>
                  {trend.map((m) => {
                    const max = Math.max(...trend.map((x) => x.cents), 1);
                    return (
                      <View key={m.key} style={styles.trendCol}>
                        <View style={styles.trendTrack}>
                          <View
                            style={[
                              styles.trendBar,
                              { height: `${Math.max(m.cents > 0 ? 6 : 0, (m.cents / max) * 100)}%` },
                            ]}
                          />
                        </View>
                        <Text style={styles.trendLabel}>{m.label}</Text>
                      </View>
                    );
                  })}
                </View>
              ) : null}

              {/* ── The breakdown. "Why is this $54 when the gig was $60" should be
                  answerable here, not in a support ticket. Rows only appear when they
                  are non-zero, so nobody reads five "$0.00" lines to find the one
                  that matters. ── */}
              <View style={styles.statGrid}>
                {[
                  { label: 'Gig totals', value: fmt(sum.grossCents), show: sum.grossCents > 0 },
                  side === 'earner'
                    ? { label: 'Platform fees', value: `− ${fmt(sum.feesCents)}`, show: sum.feesCents > 0, dim: true }
                    : { label: 'Discounts', value: `− ${fmt(sum.discountCents)}`, show: sum.discountCents > 0, good: true },
                  { label: 'Tips', value: `+ ${fmt(sum.tipsCents)}`, show: sum.tipsCents > 0, good: true },
                  {
                    label: side === 'earner' ? 'Refunded to posters' : 'Refunded to you',
                    value: `${side === 'earner' ? '−' : '+'} ${fmt(sum.refundedCents)}`,
                    show: sum.refundedCents > 0,
                    good: side !== 'earner',
                    dim: side === 'earner',
                  },
                  { label: 'Declined payments', value: String(sum.declinedCount), show: sum.declinedCount > 0, dim: true },
                  { label: 'Transactions', value: String(sum.count), show: sum.count > 0 },
                ]
                  .filter((r) => r && r.show)
                  .map((r) => (
                    <View key={r.label} style={styles.statRow}>
                      <Text style={styles.statLabel}>{r.label}</Text>
                      <Text
                        style={[
                          styles.statValue,
                          r.good && { color: colors.success },
                          r.dim && { color: colors.textSecondary },
                        ]}
                      >
                        {r.value}
                      </Text>
                    </View>
                  ))}
              </View>

              <View style={styles.actions}>
                {side === 'earner' ? (
                  <TouchableOpacity style={styles.actionBtn} onPress={openPayoutAccount}>
                    <Ionicons name="business-outline" size={15} color={colors.primary} />
                    <Text style={styles.actionText}>Bank deposits</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity style={styles.actionBtn} onPress={exportCsv} disabled={!mine.length}>
                  <Ionicons name="download-outline" size={15} color={colors.primary} />
                  <Text style={styles.actionText}>Export CSV</Text>
                </TouchableOpacity>
              </View>
            </View>
          }
          renderSectionHeader={({ section }) => <Text style={styles.monthHeader}>{section.label}</Text>}
          ListEmptyComponent={
            error ? null : (
              <View style={styles.empty}>
                <Ionicons name="receipt-outline" size={34} color={colors.textSecondary} />
                <Text style={styles.emptyTitle}>
                  {filtered
                    ? 'Nothing matches those filters'
                    : side === 'earner' ? `No earnings in ${rangeLabel.toLowerCase()}` : `Nothing charged in ${rangeLabel.toLowerCase()}`}
                </Text>
                <Text style={styles.emptyText}>
                  {filtered
                    ? 'Try a wider date range or clear the status filter.'
                    : side === 'earner'
                      ? 'Payments for gigs you complete will show up here.'
                      : 'Charges for gigs you post will show up here.'}
                </Text>
                {filtered ? (
                  <TouchableOpacity onPress={() => { setStatusKey('all'); setQuery(''); setRange('all'); }}>
                    <Text style={styles.emptyLink}>Clear filters</Text>
                  </TouchableOpacity>
                ) : null}
                {otherSideCount > 0 ? (
                  <TouchableOpacity onPress={() => { chosenRef.current = true; setSide(side === 'earner' ? 'poster' : 'earner'); }}>
                    <Text style={styles.emptyLink}>
                      You have {otherSideCount} on the {side === 'earner' ? 'Spending' : 'Earnings'} tab →
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            )
          }
        />
      )}

      {/* ── Bank deposits ────────────────────────────────────────────────────
          The last leg of the money, and the one people are actually asking about
          when they ask where their payout is. Dates come from Stripe's payout
          events — estimated while in transit, actual once paid — not from a guess. */}
      <Modal visible={payoutsOpen} transparent animationType="slide" onRequestClose={() => setPayoutsOpen(false)}>
        <View style={styles.backdrop}>
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => setPayoutsOpen(false)} />
          <View style={styles.sheet}>
            <View style={styles.grabber} />
            <Text style={styles.sheetTitle}>Bank deposits</Text>
            <Text style={styles.sheetNote}>
              Money released from a gig reaches your Stripe account right away, then
              lands in your bank on your payout schedule.
            </Text>

            <ScrollView showsVerticalScrollIndicator={false} style={{ marginTop: 14 }}>
              {payouts === null ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
              ) : payouts.length === 0 ? (
                <Text style={styles.disclaimer}>
                  No bank deposits yet. Once a gig is verified and released, your first
                  deposit will appear here with its arrival date.
                </Text>
              ) : (
                payouts.map((p) => {
                  const tone = TONE[p.tone] ?? TONE.muted;
                  return (
                    <View key={p.id} style={styles.line}>
                      <View style={{ flex: 1, paddingRight: 10 }}>
                        <Text style={styles.lineLabel}>
                          {p.verb} {p.arrivalAt ? shortDate(p.arrivalAt) : '—'}
                        </Text>
                        <View style={[styles.chip, { backgroundColor: tone.bg, alignSelf: 'flex-start', marginTop: 4 }]}>
                          <Text style={[styles.chipText, { color: tone.fg }]}>{p.label}</Text>
                        </View>
                        {p.failureMessage ? (
                          <Text style={styles.rowSub}>{p.failureMessage}</Text>
                        ) : null}
                      </View>
                      <Text style={styles.lineValue}>{fmt(p.amountCents)}</Text>
                    </View>
                  );
                })
              )}

              <TouchableOpacity style={styles.actionBtn} onPress={openStripeDashboard}>
                <Ionicons name="open-outline" size={15} color={colors.primary} />
                <Text style={styles.actionText}>Bank details & full history</Text>
              </TouchableOpacity>
            </ScrollView>

            <TouchableOpacity style={styles.closeBtn} onPress={() => setPayoutsOpen(false)}>
              <Text style={styles.closeText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <DetailSheet
        entry={detail}
        onClose={() => setDetail(null)}
        onOpenGig={(bookingId) => {
          setDetail(null);
          navigation?.navigate?.(side === 'earner' ? 'EarnTab' : 'GigsTab');
        }}
      />
    </View>
  );
}

// ── The receipt ─────────────────────────────────────────────────────────────
// Line by line, adding to the number in the list. The fee rate shown is the one
// PINNED to this booking, never today's rate — showing a past transaction at a
// current rate misstates what the person actually paid.
function DetailSheet({ entry, onClose, onOpenGig }) {
  if (!entry) return null;
  const st = paymentState(entry.status, entry.side);
  const tone = TONE[st.tone] ?? TONE.muted;
  const isEarner = entry.side === 'earner';

  const lines = isEarner
    ? [
        { label: 'Gig total', value: fmt(entry.grossCents) },
        entry.feeCents > 0 && { label: `Platform fee (${entry.feeLabel})`, value: `− ${fmt(entry.feeCents)}`, dim: true },
        entry.feeCreditCents > 0 && { label: 'Fee credit applied', value: `+ ${fmt(entry.feeCreditCents)}`, good: true },
        entry.tipCents > 0 && { label: 'Tip', value: `+ ${fmt(entry.tipCents)}`, good: true },
        entry.refundedCents > 0 && { label: 'Refunded to poster', value: `− ${fmt(entry.refundedCents)}`, dim: true },
      ]
    : [
        { label: 'Gig total', value: fmt(entry.grossCents) },
        entry.discountCents > 0 && { label: 'Discount', value: `− ${fmt(entry.discountCents)}`, good: true },
        entry.tipCents > 0 && { label: 'Tip', value: `+ ${fmt(entry.tipCents)}`, dim: true },
        entry.refundedCents > 0 && { label: 'Refunded to you', value: `− ${fmt(entry.refundedCents)}`, good: true },
      ];

  const timeline = [
    entry.authorizedAt && { label: isEarner ? 'Poster authorized payment' : 'Card authorized', at: entry.authorizedAt },
    entry.capturedAt && { label: isEarner ? 'Released to your payout account' : 'Charged to your card', at: entry.capturedAt },
    entry.refundedAt && { label: `Refunded${entry.refundReason ? ` — ${entry.refundReason}` : ''}`, at: entry.refundedAt },
    entry.cancelledAt && { label: 'Hold released', at: entry.cancelledAt },
  ].filter(Boolean);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={styles.sheetTitle}>{entry.title}</Text>
            <View style={[styles.chip, { backgroundColor: tone.bg, alignSelf: 'flex-start', marginTop: 6 }]}>
              <Text style={[styles.chipText, { color: tone.fg }]}>{st.label}</Text>
            </View>
            {st.note ? <Text style={styles.sheetNote}>{st.note}</Text> : null}

            <View style={styles.lines}>
              {lines.filter(Boolean).map((l) => (
                <View key={l.label} style={styles.line}>
                  <Text style={[styles.lineLabel, l.dim && { color: colors.textSecondary }]}>{l.label}</Text>
                  <Text style={[styles.lineValue, l.good && { color: colors.success }, l.dim && { color: colors.textSecondary }]}>
                    {l.value}
                  </Text>
                </View>
              ))}
              <View style={styles.totalLine}>
                <Text style={styles.totalLabel}>{isEarner ? 'Your payout' : 'Total charged'}</Text>
                <Text style={styles.totalValue}>{fmt(entry.netCents)}</Text>
              </View>
            </View>

            <Text style={styles.sectionLabel}>Timeline</Text>
            {timeline.map((t) => (
              <View key={t.label} style={styles.timelineRow}>
                <View style={styles.dot} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.timelineLabel}>{t.label}</Text>
                  <Text style={styles.timelineAt}>{longDate(t.at)}</Text>
                </View>
              </View>
            ))}

            {entry.settled && isEarner ? (
              <Text style={styles.disclaimer}>
                Bank deposits follow your payout account&rsquo;s schedule — open Bank deposits to see when
                this one lands.
              </Text>
            ) : null}

            <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
              <Text style={styles.closeText}>Done</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  h1: { fontSize: 26, fontWeight: '800', color: colors.textPrimary },
  sub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },

  segments: { flexDirection: 'row', backgroundColor: colors.border, borderRadius: radii.pill, padding: 3, marginTop: 14 },
  segment: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: radii.pill },
  segmentOn: { backgroundColor: colors.surface, ...shadows.sm },
  segmentText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  segmentTextOn: { color: colors.textPrimary },

  chipRow: { gap: 6, paddingTop: 10, paddingRight: 16 },
  chip2: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: radii.pill,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  chip2On: { backgroundColor: colors.primary, borderColor: colors.primary },
  chip2Text: { fontSize: 12.5, fontWeight: '700', color: colors.textSecondary },
  chip2TextOn: { color: '#fff' },
  search: {
    marginTop: 10, backgroundColor: colors.surface, borderRadius: radii.pill,
    borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 9,
    fontSize: 14, color: colors.textPrimary,
  },

  trend: { flexDirection: 'row', gap: 8, height: 92, marginTop: 12, paddingHorizontal: 4 },
  trendCol: { flex: 1, alignItems: 'center' },
  trendTrack: { flex: 1, width: '100%', justifyContent: 'flex-end', backgroundColor: colors.border, borderRadius: radii.sm, overflow: 'hidden' },
  trendBar: { width: '100%', backgroundColor: colors.primary, borderRadius: radii.sm },
  trendLabel: { fontSize: 10, color: colors.textSecondary, marginTop: 4, fontWeight: '600' },

  statGrid: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 14, marginTop: 12, ...shadows.sm },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  statLabel: { fontSize: 13.5, color: colors.textPrimary, flex: 1, paddingRight: 10 },
  statValue: { fontSize: 13.5, fontWeight: '700', color: colors.textPrimary },

  summaryWrap: { paddingHorizontal: 16, paddingTop: 14 },
  summary: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, ...shadows.card },
  summaryCell: { flex: 1 },
  summaryDivider: { width: 1, backgroundColor: colors.border, marginHorizontal: 12 },
  summaryLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  summaryValue: { fontSize: 24, fontWeight: '800', color: colors.textPrimary, marginTop: 4 },
  summaryHint: { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  feeNote: { fontSize: 12, color: colors.textSecondary, marginTop: 8, paddingHorizontal: 2 },

  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12,
    borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  actionText: { fontSize: 13, fontWeight: '700', color: colors.primary },

  errorCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.urgentLight,
    borderRadius: radii.md, padding: 12, marginBottom: 12,
  },
  errorText: { flex: 1, fontSize: 13, color: colors.urgent, fontWeight: '600' },
  retry: { fontSize: 13, fontWeight: '800', color: colors.urgent },

  monthHeader: {
    fontSize: 12, fontWeight: '800', color: colors.textSecondary, textTransform: 'uppercase',
    letterSpacing: 0.5, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    marginHorizontal: 16, marginBottom: 8, padding: 14, borderRadius: radii.lg, ...shadows.sm,
  },
  rowTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5 },
  rowDate: { fontSize: 12, color: colors.textSecondary },
  rowAmount: { fontSize: 16, fontWeight: '800', color: colors.textPrimary },
  rowAmountVoid: { color: colors.textSecondary, textDecorationLine: 'line-through' },
  rowSub: { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radii.pill },
  chipText: { fontSize: 11, fontWeight: '800' },

  empty: { alignItems: 'center', paddingTop: 50, paddingHorizontal: 40 },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: colors.textPrimary, marginTop: 12 },
  emptyText: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginTop: 4 },
  emptyLink: { fontSize: 13, fontWeight: '700', color: colors.primary, marginTop: 14 },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    padding: 20, maxHeight: '85%',
  },
  grabber: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 14 },
  sheetTitle: { fontSize: 19, fontWeight: '800', color: colors.textPrimary },
  sheetNote: { fontSize: 13, color: colors.textSecondary, marginTop: 10, lineHeight: 19 },

  lines: { marginTop: 18, backgroundColor: colors.background, borderRadius: radii.lg, padding: 14 },
  line: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 },
  lineLabel: { fontSize: 14, color: colors.textPrimary, flex: 1, paddingRight: 10 },
  lineValue: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  totalLine: {
    flexDirection: 'row', justifyContent: 'space-between', paddingTop: 10, marginTop: 6,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  totalLabel: { fontSize: 15, fontWeight: '800', color: colors.textPrimary },
  totalValue: { fontSize: 17, fontWeight: '800', color: colors.textPrimary },

  sectionLabel: {
    fontSize: 12, fontWeight: '800', color: colors.textSecondary, textTransform: 'uppercase',
    letterSpacing: 0.5, marginTop: 22, marginBottom: 10,
  },
  timelineRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary, marginTop: 5 },
  timelineLabel: { fontSize: 14, color: colors.textPrimary, fontWeight: '600' },
  timelineAt: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },

  disclaimer: { fontSize: 12, color: colors.textSecondary, lineHeight: 18, marginTop: 8 },
  closeBtn: {
    backgroundColor: colors.primary, borderRadius: radii.pill, paddingVertical: 14,
    alignItems: 'center', marginTop: 22, marginBottom: 10,
  },
  closeText: { fontSize: 15, fontWeight: '800', color: '#fff' },
});
