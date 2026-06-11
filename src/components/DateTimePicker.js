import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
} from 'react-native';
import { colors, shadows } from '../theme';
import { useHaptic } from '../hooks/useHaptic';

const DAY_ABBR  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_ABBR  = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TIMES     = [
  '8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM',
  '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM',
  '6:00 PM', '7:00 PM', '8:00 PM',
];

function getNext14Days() {
  const now = new Date();
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    return {
      key: d.toDateString(),
      dayName: i === 0 ? 'Today' : i === 1 ? 'Tmrw' : DAY_ABBR[d.getDay()],
      dayNum: d.getDate(),
      month: MON_ABBR[d.getMonth()],
      label: `${DAY_ABBR[d.getDay()]} ${MON_ABBR[d.getMonth()]} ${d.getDate()}`,
    };
  });
}

const DAYS = getNext14Days();

export default function DateTimePicker({ slots = [], onChange }) {
  const haptic = useHaptic();
  const [selectedDay, setSelectedDay] = useState(null);
  const [selectedTime, setSelectedTime] = useState(null);

  const addSlot = () => {
    if (!selectedDay || !selectedTime) return;
    const label = `${selectedDay.label}, ${selectedTime}`;
    const already = slots.some(s => s.label === label);
    if (already) return;
    haptic.medium();
    onChange([...slots, { id: `s${Date.now()}`, label, taken: false }]);
    setSelectedTime(null);
  };

  const removeSlot = (id) => {
    haptic.light();
    onChange(slots.filter(s => s.id !== id));
  };

  return (
    <View>
      {/* Day picker */}
      <Text style={styles.subLabel}>Select a date</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dayRow}>
        {DAYS.map(d => {
          const active = selectedDay?.key === d.key;
          return (
            <TouchableOpacity
              key={d.key}
              style={[styles.dayChip, active && styles.dayChipActive]}
              onPress={() => { haptic.selection(); setSelectedDay(d); setSelectedTime(null); }}
            >
              <Text style={[styles.dayName, active && styles.dayNameActive]}>{d.dayName}</Text>
              <Text style={[styles.dayNum, active && styles.dayNumActive]}>{d.dayNum}</Text>
              <Text style={[styles.dayMonth, active && styles.dayMonthActive]}>{d.month}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Time picker */}
      {selectedDay && (
        <>
          <Text style={[styles.subLabel, { marginTop: 14 }]}>Select a time</Text>
          <View style={styles.timeGrid}>
            {TIMES.map(t => {
              const active = selectedTime === t;
              return (
                <TouchableOpacity
                  key={t}
                  style={[styles.timeChip, active && styles.timeChipActive]}
                  onPress={() => { haptic.selection(); setSelectedTime(t); }}
                >
                  <Text style={[styles.timeText, active && styles.timeTextActive]}>{t}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      )}

      {/* Add button */}
      {selectedDay && selectedTime && (
        <TouchableOpacity style={styles.addBtn} onPress={addSlot}>
          <Text style={styles.addBtnText}>+ Add {selectedDay.label}, {selectedTime}</Text>
        </TouchableOpacity>
      )}

      {/* Added slots */}
      {slots.length > 0 && (
        <View style={styles.slotList}>
          {slots.map(s => (
            <View key={s.id} style={styles.slotTag}>
              <Text style={styles.slotTagText}>📅 {s.label}</Text>
              <TouchableOpacity onPress={() => removeSlot(s.id)} style={styles.slotRemove}>
                <Text style={styles.slotRemoveText}>✕</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {slots.length === 0 && !selectedDay && (
        <Text style={styles.hint}>Tap a date above to start adding time slots</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  subLabel: { fontSize: 12, fontWeight: '700', color: colors.textMuted, marginBottom: 8 },
  dayRow: { paddingBottom: 4 },
  dayChip: {
    alignItems: 'center', width: 56, paddingVertical: 10, marginRight: 8,
    borderRadius: 14, backgroundColor: colors.surface,
    borderWidth: 1.5, borderColor: colors.border,
  },
  dayChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  dayName: { fontSize: 10, fontWeight: '700', color: colors.textMuted },
  dayNameActive: { color: 'rgba(255,255,255,0.8)' },
  dayNum: { fontSize: 20, fontWeight: '900', color: colors.textPrimary, lineHeight: 24 },
  dayNumActive: { color: '#fff' },
  dayMonth: { fontSize: 10, fontWeight: '600', color: colors.textMuted },
  dayMonthActive: { color: 'rgba(255,255,255,0.75)' },
  timeGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  timeChip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
    backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border,
    marginRight: 8, marginBottom: 8,
  },
  timeChipActive: { backgroundColor: colors.secondary, borderColor: colors.secondary },
  timeText: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  timeTextActive: { color: '#fff' },
  addBtn: {
    backgroundColor: colors.primaryLight, borderRadius: 12,
    padding: 12, alignItems: 'center', marginTop: 4,
  },
  addBtnText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  slotList: { marginTop: 12 },
  slotTag: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.accentLight, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 9, marginBottom: 6,
  },
  slotTagText: { fontSize: 13, fontWeight: '600', color: colors.success },
  slotRemove: { padding: 4 },
  slotRemoveText: { fontSize: 14, color: colors.textMuted, fontWeight: '700' },
  hint: { fontSize: 13, color: colors.textMuted, textAlign: 'center', marginTop: 8, fontStyle: 'italic' },
});
