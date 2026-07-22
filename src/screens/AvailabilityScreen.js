import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { DAYS, fmtTime } from '../lib/availability';
import { useUser } from '../context/UserContext';
import { useAuth } from '../context/AuthContext';
import { useHaptic } from '../hooks/useHaptic';
import { listClasses, addClass, deleteClass } from '../lib/schedule';
import WorkStatusBar from '../components/WorkStatusBar';
import { colors, radii, shadows } from '../theme';

const STEP = 30;       // minutes
const MIN_M = 6 * 60;  // 6:00 AM
const MAX_M = 22 * 60; // 10:00 PM

const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fromHHMM = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

function TimeStepper({ value, onChange }) {
  const m = fromHHMM(value);
  return (
    <View style={styles.stepper}>
      <TouchableOpacity onPress={() => onChange(toHHMM(Math.max(MIN_M, m - STEP)))} style={styles.stepBtn}>
        <Ionicons name="remove" size={16} color={colors.textPrimary} />
      </TouchableOpacity>
      <Text style={styles.stepText} numberOfLines={1}>{fmtTime(value)}</Text>
      <TouchableOpacity onPress={() => onChange(toHHMM(Math.min(MAX_M, m + STEP)))} style={styles.stepBtn}>
        <Ionicons name="add" size={16} color={colors.textPrimary} />
      </TouchableOpacity>
    </View>
  );
}

function DayChips({ selected, onToggle, single }) {
  return (
    <View style={styles.dayRow}>
      {DAYS.map((d, i) => {
        const active = single ? selected === i : selected.includes(i);
        return (
          <TouchableOpacity key={i} onPress={() => onToggle(i)} style={[styles.dayChip, active && styles.dayChipActive]}>
            <Text style={[styles.dayChipText, active && styles.dayChipTextActive]} numberOfLines={1}>{d}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function AvailabilityScreen() {
  const { availability, setAvailability, showToast } = useUser();
  const { user } = useAuth();
  const haptic = useHaptic();

  // availability window form
  const [day, setDay] = useState(1);
  const [start, setStart] = useState('15:00');
  const [end, setEnd] = useState('20:00');

  const addWindow = () => {
    if (fromHHMM(start) >= fromHHMM(end)) {
      showToast?.({ icon: '⚠️', title: 'Check the times', message: 'End must be after start.' });
      return;
    }
    haptic?.light?.();
    setAvailability([...(availability || []), { day, start, end }]);
  };
  const removeWindow = (idx) => setAvailability((availability || []).filter((_, i) => i !== idx));

  // class schedule
  const [classes, setClasses] = useState([]);
  const [cTitle, setCTitle] = useState('');
  const [cDays, setCDays] = useState([]);
  const [cStart, setCStart] = useState('10:00');
  const [cEnd, setCEnd] = useState('11:00');

  useEffect(() => {
    if (user) listClasses(user.id).then(setClasses).catch(() => {});
  }, [user?.id]);

  const toggleCDay = (d) => setCDays((ds) => (ds.includes(d) ? ds.filter((x) => x !== d) : [...ds, d]));

  const saveClass = async () => {
    if (!cTitle.trim() || cDays.length === 0 || !user) return;
    if (fromHHMM(cStart) >= fromHHMM(cEnd)) {
      showToast?.({ icon: '⚠️', title: 'Check the times', message: 'End must be after start.' });
      return;
    }
    try {
      await addClass(user.id, { title: cTitle.trim(), days: [...cDays].sort(), start_time: cStart, end_time: cEnd });
      setClasses(await listClasses(user.id));
      setCTitle('');
      setCDays([]);
      showToast?.({ icon: '📚', title: 'Class added' });
    } catch {
      showToast?.({ icon: '⚠️', title: "Couldn't add class", message: 'Please try again.' });
    }
  };

  const removeClass = async (id) => {
    try {
      await deleteClass(id);
      setClasses((cs) => cs.filter((c) => c.id !== id));
    } catch {
      showToast?.({ icon: '⚠️', title: "Couldn't delete", message: 'Please try again.' });
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 20, paddingBottom: 48, gap: 16 }}
      automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
      <Text style={styles.lead}>When you can work — Hustlr AI uses this to match gigs to your free time.</Text>

      <WorkStatusBar />

      {/* Weekly availability */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Weekly availability</Text>
        {(availability || []).length > 0 ? (
          (availability || []).map((w, i) => (
            <View key={i} style={styles.rowItem}>
              <Text style={styles.rowText} numberOfLines={1}>{DAYS[w.day]} · {fmtTime(w.start)}–{fmtTime(w.end)}</Text>
              <TouchableOpacity onPress={() => removeWindow(i)} style={styles.rowAction}>
                <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          ))
        ) : (
          <Text style={styles.empty}>No availability set yet.</Text>
        )}
        <DayChips selected={day} onToggle={setDay} single />
        <View style={styles.timeRow}>
          <TimeStepper value={start} onChange={setStart} />
          <Text style={styles.toText}>to</Text>
          <TimeStepper value={end} onChange={setEnd} />
        </View>
        <TouchableOpacity style={styles.addBtn} onPress={addWindow}>
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={styles.addBtnText} numberOfLines={1}>Add window</Text>
        </TouchableOpacity>
      </View>

      {/* Class schedule */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Class schedule</Text>
        <Text style={styles.cardSub}>Your classes block the times you can&apos;t work.</Text>
        {classes.length > 0 ? (
          classes.map((c) => (
            <View key={c.id} style={styles.rowItem}>
              <Text style={styles.rowText} numberOfLines={2}>
                <Text style={styles.rowStrong}>{c.title}</Text>  {(c.days || []).map((d) => DAYS[d]).join('/')} · {fmtTime(c.start_time)}–{fmtTime(c.end_time)}
              </Text>
              <TouchableOpacity onPress={() => removeClass(c.id)} style={styles.rowAction}>
                <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          ))
        ) : (
          <Text style={styles.empty}>No classes added yet.</Text>
        )}
        <TextInput
          style={styles.input}
          value={cTitle}
          onChangeText={setCTitle}
          placeholder="Class name (e.g. CS 101)"
          placeholderTextColor={colors.textMuted}
        />
        <DayChips selected={cDays} onToggle={toggleCDay} />
        <View style={styles.timeRow}>
          <TimeStepper value={cStart} onChange={setCStart} />
          <Text style={styles.toText}>to</Text>
          <TimeStepper value={cEnd} onChange={setCEnd} />
        </View>
        <TouchableOpacity
          style={[styles.addBtn, (!cTitle.trim() || cDays.length === 0) && { opacity: 0.4 }]}
          onPress={saveClass}
          disabled={!cTitle.trim() || cDays.length === 0}
        >
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={styles.addBtnText} numberOfLines={1}>Add class</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  lead: { fontSize: 14, color: colors.textSecondary, lineHeight: 20 },
  card: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, ...shadows.card },
  cardTitle: { fontSize: 16, lineHeight: 21, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.2, marginBottom: 4 },
  cardSub: { fontSize: 13, color: colors.textMuted, lineHeight: 18, marginBottom: 12 },
  empty: { fontSize: 14, color: colors.textMuted, lineHeight: 20, marginBottom: 8 },
  rowItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    backgroundColor: colors.background, borderRadius: radii.md,
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8,
  },
  rowText: { flex: 1, flexShrink: 1, fontSize: 14, lineHeight: 19, color: colors.textPrimary },
  rowStrong: { fontWeight: '600' },
  rowAction: { flexShrink: 0, padding: 4 },
  dayRow: { flexDirection: 'row', gap: 4, marginTop: 8, marginBottom: 12 },
  dayChip: { flex: 1, alignItems: 'center', backgroundColor: colors.background, borderRadius: radii.pill, paddingVertical: 8, paddingHorizontal: 4 },
  dayChipActive: { backgroundColor: colors.primary },
  dayChipText: { fontSize: 11, fontWeight: '600', color: colors.textSecondary },
  dayChipTextActive: { color: '#fff' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  // flex:1 (not flexShrink) so both steppers always split the row evenly — the
  // label can never push the +/- buttons off a narrow screen, and the width
  // stays constant as the time label changes, so nothing jitters.
  stepper: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.background, borderRadius: radii.md,
    paddingHorizontal: 6, paddingVertical: 4,
  },
  stepBtn: {
    width: 28, height: 28, borderRadius: radii.pill, flexShrink: 0,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  stepText: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: '600', color: colors.textPrimary, textAlign: 'center' },
  toText: { fontSize: 13, color: colors.textMuted, flexShrink: 0 },
  input: {
    backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border,
    borderRadius: radii.md, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, color: colors.textPrimary, marginBottom: 4,
  },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 12, paddingHorizontal: 16,
  },
  addBtnText: { color: '#fff', fontSize: 15, fontWeight: '600', flexShrink: 1 },
});
