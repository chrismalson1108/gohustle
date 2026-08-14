// ─────────────────────────────────────────────────────────────────────────────
// Everything Hustlr AI has written down about you, and a way to take it back.
//
// The assistant's `remember` tool has existed for months; nothing ever showed the
// result. A stored fact is replayed into the system prompt of every future
// conversation, so until this screen the only way to remove one was to keep
// chatting until 25 newer facts pushed it out. "We told you in chat when we saved
// it" is not a control — it is model-generated text on a screen the user has
// already scrolled past, produced by the same model that would have to choose to
// mention it.
//
// So the two things this screen owes are plain: show ALL of them, and let any one
// of them go in a single tap.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import ScreenHeader from '../components/ScreenHeader';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import { fetchMemories, forgetMemory, forgetAllMemories } from '../lib/assistantMemory';
import { colors, radii } from '../theme';

// Sentinel for the bulk action, so one `busy` value drives both spinners. The LEADING
// SPACE is what makes that safe: fetchMemories trims every stored fact, so no real one
// can ever equal this and disable the wrong control.
const CLEAR_ALL = ' all';

export default function AssistantMemoryScreen() {
  const { showToast } = useUser();
  const haptic = useHaptic();

  // THREE states, not two. `null` is "we haven't got them yet" and `err` is "we asked
  // and failed" — collapsing either into an empty array tells someone nothing is stored
  // about them while it still is, which is the one wrong answer this screen must never
  // give.
  const [memories, setMemories] = useState(null);
  const [err, setErr] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(null);          // the fact currently being removed
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    try {
      setMemories(await fetchMemories());
      setErr(null);
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    // Re-read on focus: a chat in the assistant sheet can add a fact while this screen
    // sits in the back stack.
    load();
    return () => setConfirmClear(false);
  }, [load]));

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const remove = async (fact) => {
    haptic.medium();
    setBusy(fact);
    try {
      // forgetMemory re-reads before it writes, so a success here also means the read
      // path is working again — clear any stale-list banner an earlier failure left.
      setMemories(await forgetMemory(fact));
      setErr(null);
      haptic.success();
      // Quote it back. A mis-tap on a small trash icon is otherwise invisible: the row
      // simply vanishes and the user cannot tell which one went.
      showToast({ icon: '🗑️', title: 'Forgotten', message: `Hustlr AI won't remember “${fact}” any more.` });
    } catch (e) {
      haptic.error();
      showToast({ icon: '⚠️', title: "Couldn't delete that", message: e.message });
    } finally {
      setBusy(null);
    }
  };

  const clearAll = async () => {
    haptic.medium();
    setBusy(CLEAR_ALL);
    try {
      setMemories(await forgetAllMemories());
      setErr(null);
      setConfirmClear(false);
      haptic.success();
      showToast({ icon: '🗑️', title: 'Memory cleared', message: 'Hustlr AI starts fresh from your next message.' });
    } catch (e) {
      haptic.error();
      showToast({ icon: '⚠️', title: "Couldn't clear that", message: e.message });
    } finally {
      setBusy(null);
    }
  };

  // Built as named pieces rather than one nested ternary chain: the states this screen
  // has to keep apart (loading / failed / stale / empty / list) are exactly the ones a
  // chain collapses by accident.
  const failed = (
    <View style={styles.state}>
      <Ionicons name="cloud-offline-outline" size={38} color={colors.textMuted} />
      <Text style={styles.stateTitle}>We couldn't load your notes</Text>
      <Text style={styles.stateText}>{err}</Text>
      <TouchableOpacity style={styles.retry} onPress={load} accessibilityRole="button">
        <Text style={styles.retryText}>Try again</Text>
      </TouchableOpacity>
    </View>
  );

  const nothingYet = (
    <View style={styles.state}>
      <Ionicons name="sparkles-outline" size={38} color={colors.textMuted} />
      <Text style={styles.stateTitle}>Nothing saved yet</Text>
      <Text style={styles.stateText}>
        When you tell Hustlr AI something worth keeping — a savings goal, the kind of gigs
        you want — it'll show up here.
      </Text>
    </View>
  );

  const list = memories && (
    <>
      <View style={styles.card}>
        {memories.map((fact, i) => (
          // Keyed on index AND text: rows written before the assistant de-duped can
          // still hold two identical strings side by side.
          <View key={`${i}-${fact}`} style={[styles.row, i === memories.length - 1 && styles.rowLast]}>
            <Text style={styles.fact}>{fact}</Text>
            {busy === fact ? (
              <ActivityIndicator color={colors.textMuted} style={styles.trash} />
            ) : (
              <TouchableOpacity
                style={styles.trash}
                onPress={() => remove(fact)}
                hitSlop={10}
                disabled={!!busy}
                accessibilityRole="button"
                accessibilityLabel={`Forget: ${fact}`}
              >
                <Ionicons name="trash-outline" size={18} color={colors.urgent} />
              </TouchableOpacity>
            )}
          </View>
        ))}
      </View>

      {/* Bulk delete is the one action here worth a second tap — one stray press should
          not wipe the lot. An inline confirm, not Alert.alert, whose buttons are a
          no-op on web. */}
      {confirmClear ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmTitle}>Forget all {memories.length} notes?</Text>
          <Text style={styles.confirmText}>
            This can't be undone. Hustlr AI will start over, and may ask you things it
            already knew.
          </Text>
          <View style={styles.confirmRow}>
            <TouchableOpacity
              style={[styles.confirmBtn, styles.confirmCancel]}
              onPress={() => { haptic.light(); setConfirmClear(false); }}
              accessibilityRole="button"
            >
              <Text style={styles.confirmCancelText}>Keep them</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.confirmBtn, styles.confirmGo, !!busy && { opacity: 0.5 }]}
              onPress={clearAll}
              // ANY write in flight, not just a clear-all: a per-row delete racing this
              // one can land last and restore the facts this claims to have erased. On a
              // privacy screen, saying data is gone when it is not is the error that matters.
              disabled={!!busy}
              accessibilityRole="button"
            >
              {busy === CLEAR_ALL
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.confirmGoText}>Forget everything</Text>}
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.clear}
          onPress={() => { haptic.medium(); setConfirmClear(true); }}
          disabled={!!busy}
          accessibilityRole="button"
        >
          <Ionicons name="trash-outline" size={17} color={colors.urgent} />
          <Text style={styles.clearText}>Forget everything</Text>
        </TouchableOpacity>
      )}
    </>
  );

  return (
    <View style={styles.container}>
      <ScreenHeader topInset={false}>
        <Text style={styles.lede}>
          Hustlr AI jots down short notes about you as you chat, and reads them back at the
          start of every new conversation so you don't have to repeat yourself. It keeps the
          25 most recent. Delete anything you'd rather it forgot.
        </Text>
      </ScreenHeader>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 60 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {memories === null ? (
          err ? failed : <View style={styles.state}><ActivityIndicator color={colors.primary} /></View>
        ) : (
          <>
            {/* A refresh that fails AFTER a good load must not throw the good list away.
                The whole point of this screen is being able to see what is held, and a
                full-screen error where a list used to be reads as "nothing is stored". */}
            {err ? (
              <View style={styles.stale}>
                <Ionicons name="cloud-offline-outline" size={15} color={colors.textSecondary} />
                <Text style={styles.staleText}>Couldn't refresh — this is the last list we loaded.</Text>
              </View>
            ) : null}
            {memories.length === 0 ? nothingYet : list}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  lede: { fontSize: 14, color: colors.textSecondary, lineHeight: 21 },

  stale: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 20, marginBottom: 10, paddingVertical: 10, paddingHorizontal: 12,
    borderRadius: radii.md, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
  },
  staleText: { flex: 1, fontSize: 12.5, color: colors.textSecondary, lineHeight: 17 },

  card: {
    backgroundColor: colors.surface, borderRadius: radii.lg,
    marginHorizontal: 20, marginTop: 6, overflow: 'hidden',
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14, paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  rowLast: { borderBottomWidth: 0 },
  fact: { flex: 1, fontSize: 15, color: colors.textPrimary, lineHeight: 21 },
  trash: { width: 26, alignItems: 'flex-end' },

  clear: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginHorizontal: 20, marginTop: 18, paddingVertical: 14,
    borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  clearText: { fontSize: 15, fontWeight: '600', color: colors.urgent },

  confirm: {
    marginHorizontal: 20, marginTop: 18, padding: 16,
    borderRadius: radii.lg, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.urgentLight,
  },
  confirmTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  confirmText: { fontSize: 13.5, color: colors.textSecondary, marginTop: 6, lineHeight: 19 },
  confirmRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  confirmBtn: { flex: 1, paddingVertical: 12, borderRadius: radii.pill, alignItems: 'center' },
  confirmCancel: { backgroundColor: colors.background },
  confirmCancelText: { fontSize: 14.5, fontWeight: '700', color: colors.textPrimary },
  confirmGo: { backgroundColor: colors.urgent },
  confirmGoText: { fontSize: 14.5, fontWeight: '700', color: '#fff' },

  state: { alignItems: 'center', paddingHorizontal: 36, paddingTop: 54 },
  stateTitle: {
    fontSize: 16.5, fontWeight: '700', color: colors.textPrimary,
    marginTop: 12, textAlign: 'center',
  },
  stateText: {
    fontSize: 13.5, color: colors.textSecondary, marginTop: 6,
    textAlign: 'center', lineHeight: 20,
  },
  retry: {
    marginTop: 16, paddingVertical: 11, paddingHorizontal: 22,
    borderRadius: radii.pill, backgroundColor: colors.primary,
  },
  retryText: { color: '#fff', fontWeight: '700', fontSize: 14.5 },
});
