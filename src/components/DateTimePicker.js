import React, { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii } from '../theme';
import { useHaptic } from '../hooks/useHaptic';

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TIMES = [
  '8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM',
  '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM',
  '6:00 PM', '7:00 PM', '8:00 PM',
];

const FLEXIBLE_LABEL = 'Flexible — Contact to Schedule';

function buildDays() {
  const now = new Date();
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    return {
      key: d.toDateString(),
      date: d,
      dayName: i === 0 ? 'Today' : i === 1 ? 'Tmrw' : DAY_ABBR[d.getDay()],
      dayNum: d.getDate(),
      month: MON_ABBR[d.getMonth()],
      label: `${DAY_ABBR[d.getDay()]} ${MON_ABBR[d.getMonth()]} ${d.getDate()}`,
    };
  });
}

// "3:00 PM" + a base Date → ISO string for that day/time
function computeStartsAt(baseDate, timeStr) {
  try {
    const m = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    const pm = /pm/i.test(m[3]);
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    const d = new Date(baseDate);
    d.setHours(h, min, 0, 0);
    return d.toISOString();
  } catch { return null; }
}

export default function DateTimePicker({ slots = [], onChange }) {
  const haptic = useHaptic();
  const [selectedDay, setSelectedDay] = useState(null);
  // Recompute dates on each mount so they're never stale
  const days = useMemo(() => buildDays(), []);

  const hasFlexible = slots.some(s => s.label === FLEXIBLE_LABEL);

  const addFlexible = () => {
    if (hasFlexible) return;
    haptic.medium();
    onChange([...slots, { id: `s${Date.now()}`, label: FLEXIBLE_LABEL, taken: false }]);
  };

  // Auto-add on time tap — no separate "Add" button needed
  const handleTimeSelect = (time) => {
    if (!selectedDay) return;
    const startsAt = computeStartsAt(selectedDay.date, time);
    // Never allow a slot in the past (e.g. earlier times on "Today").
    if (startsAt && new Date(startsAt).getTime() <= Date.now()) return;
    const label = `${selectedDay.label}, ${time}`;
    if (slots.some(s => s.label === label)) return; // already added
    haptic.medium();
    onChange([...slots, { id: `s${Date.now()}`, label, taken: false, startsAt }]);
  };

  const removeSlot = (id) => {
    haptic.light();
    onChange(slots.filter(s => s.id !== id));
  };

  // Which times are already added for the currently selected day
  const addedTimes = useMemo(() => {
    if (!selectedDay) return new Set();
    return new Set(
      slots
        .filter(s => s.label.startsWith(selectedDay.label + ','))
        .map(s => s.label.slice(selectedDay.label.length + 2))
    );
  }, [slots, selectedDay]);

  return (
    <View>
      {/* Flexible button */}
      <TouchableOpacity
        style={[styles.flexBtn, hasFlexible && styles.flexBtnActive]}
        onPress={addFlexible}
        activeOpacity={hasFlexible ? 1 : 0.75}
      >
        <Ionicons
          name={hasFlexible ? 'checkmark' : 'calendar-outline'}
          size={15}
          color={hasFlexible ? colors.primary : colors.textSecondary}
          style={{ marginRight: 6 }}
        />
        <Text
          style={[styles.flexBtnText, hasFlexible && styles.flexBtnTextActive]}
          numberOfLines={1}
        >
          Flexible — Contact to Schedule
        </Text>
      </TouchableOpacity>

      <Text style={styles.orDivider} numberOfLines={2}>or pick specific times below</Text>

      {/* Day picker */}
      <Text style={styles.subLabel}>Select a date</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dayRow}>
        {days.map(d => {
          const active = selectedDay?.key === d.key;
          return (
            <TouchableOpacity
              key={d.key}
              style={[styles.dayChip, active && styles.dayChipActive]}
              onPress={() => { haptic.selection(); setSelectedDay(d); }}
            >
              <Text style={[styles.dayName, active && styles.dayNameActive]}>{d.dayName}</Text>
              <Text style={[styles.dayNum, active && styles.dayNumActive]}>{d.dayNum}</Text>
              <Text style={[styles.dayMonth, active && styles.dayMonthActive]}>{d.month}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Time grid — tap to instantly add */}
      {selectedDay && (
        <>
          <Text style={[styles.subLabel, { marginTop: 16 }]}>
            Tap a time to add it
          </Text>
          <View style={styles.timeGrid}>
            {TIMES.map(t => {
              const added = addedTimes.has(t);
              const startsAt = computeStartsAt(selectedDay.date, t);
              const past = startsAt ? new Date(startsAt).getTime() <= Date.now() : false;
              return (
                <TouchableOpacity
                  key={t}
                  style={[styles.timeChip, added && styles.timeChipAdded, past && styles.timeChipPast]}
                  onPress={() => handleTimeSelect(t)}
                  disabled={past}
                  activeOpacity={added || past ? 1 : 0.7}
                >
                  {added && (
                    <Ionicons name="checkmark" size={12} color="#fff" style={{ marginRight: 4 }} />
                  )}
                  <Text
                    style={[styles.timeText, added && styles.timeTextAdded, past && styles.timeTextPast]}
                    numberOfLines={1}
                  >
                    {t}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      )}

      {/* Added slots list */}
      {slots.length > 0 && (
        <View style={styles.slotList}>
          <Text style={styles.addedLabel}>Added slots</Text>
          {slots.map(s => (
            <View key={s.id} style={styles.slotTag}>
              <View style={styles.slotTagLabel}>
                <Ionicons name="calendar-outline" size={13} color={colors.textMuted} style={{ marginRight: 8 }} />
                <Text style={styles.slotTagText} numberOfLines={1}>{s.label}</Text>
              </View>
              <TouchableOpacity onPress={() => removeSlot(s.id)} style={styles.slotRemove}>
                <Ionicons name="close" size={14} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {slots.length === 0 && !selectedDay && (
        <Text style={styles.hint}>
          Tap "Flexible" above, or select a date to add specific times
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flexBtn: {
    backgroundColor: colors.surface, borderRadius: radii.md,
    paddingHorizontal: 16, paddingVertical: 14,
    alignItems: 'center', marginBottom: 12,
    borderWidth: 1, borderColor: colors.border,
    flexDirection: 'row', justifyContent: 'center',
  },
  flexBtnActive: { backgroundColor: colors.primaryLight, borderColor: colors.primaryLight },
  flexBtnText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary, flexShrink: 1, lineHeight: 18 },
  flexBtnTextActive: { color: colors.primary },
  orDivider: {
    fontSize: 12, color: colors.textMuted, textAlign: 'center',
    marginBottom: 16, lineHeight: 16,
  },
  subLabel: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 8, lineHeight: 17 },
  dayRow: { paddingBottom: 4 },
  dayChip: {
    alignItems: 'center', minWidth: 56, paddingHorizontal: 8, paddingVertical: 10, marginRight: 8,
    borderRadius: radii.md, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
  },
  dayChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  dayName: { fontSize: 11, fontWeight: '600', color: colors.textMuted, lineHeight: 15 },
  dayNameActive: { color: 'rgba(255,255,255,0.85)' },
  dayNum: { fontSize: 20, fontWeight: '700', color: colors.textPrimary, lineHeight: 26 },
  dayNumActive: { color: '#fff' },
  dayMonth: { fontSize: 11, fontWeight: '500', color: colors.textMuted, lineHeight: 15 },
  dayMonthActive: { color: 'rgba(255,255,255,0.85)' },
  timeGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  timeChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: radii.pill,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    marginRight: 8, marginBottom: 8, alignSelf: 'flex-start',
    flexDirection: 'row', alignItems: 'center',
  },
  timeChipAdded: { backgroundColor: colors.primary, borderColor: colors.primary },
  timeChipPast: { backgroundColor: colors.divider, borderColor: colors.divider, opacity: 0.6 },
  timeText: { fontSize: 13, fontWeight: '500', color: colors.textSecondary, lineHeight: 17 },
  timeTextAdded: { color: '#fff', fontWeight: '600' },
  timeTextPast: { color: colors.textMuted, textDecorationLine: 'line-through' },
  slotList: { marginTop: 16 },
  addedLabel: {
    fontSize: 13, fontWeight: '600', color: colors.textMuted,
    marginBottom: 8, lineHeight: 17,
  },
  slotTag: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8,
  },
  slotTagLabel: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  slotTagText: { fontSize: 14, fontWeight: '500', color: colors.textPrimary, flexShrink: 1, lineHeight: 18 },
  slotRemove: { padding: 4, flexShrink: 0 },
  hint: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: 12, lineHeight: 18 },
});
