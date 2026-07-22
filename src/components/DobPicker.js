import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Modal, FlatList, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, shadows } from '../theme';

// Month / Day / Year dropdowns for date-of-birth entry — replaces the free-form
// MM/DD/YYYY text input (typo-prone, awkward on mobile keyboards). Pure JS
// (modal option lists), so it works in Expo Go and on web with no native picker.
//
// Controlled: `value` is { month, day, year } (numbers or null), `onChange(next)`
// receives the full parts object. Compose the parts into a parseDob-compatible
// string with `composeDob(value)` — null until all three parts are chosen.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const daysInMonth = (month, year) =>
  month ? new Date(year || 2000, month, 0).getDate() : 31;

export function composeDob(value) {
  const { month, day, year } = value || {};
  if (!month || !day || !year) return null;
  return `${month}/${day}/${year}`;
}

export default function DobPicker({ value, onChange, error }) {
  const [open, setOpen] = useState(null); // 'month' | 'day' | 'year' | null
  const { month, day, year } = value || {};

  const now = new Date();
  const years = Array.from({ length: now.getFullYear() - 1920 + 1 }, (_, i) => now.getFullYear() - i);
  const days = Array.from({ length: daysInMonth(month, year) }, (_, i) => i + 1);

  const pick = (part, v) => {
    const next = { ...value, [part]: v };
    // Changing month/year can invalidate the chosen day (e.g. Feb 30) — clear it.
    if (part !== 'day' && next.day && next.day > daysInMonth(next.month, next.year)) next.day = null;
    setOpen(null);
    onChange(next);
  };

  const options = open === 'month'
    ? MONTHS.map((label, i) => ({ label, v: i + 1 }))
    : open === 'day'
      ? days.map(d => ({ label: String(d), v: d }))
      : years.map(y => ({ label: String(y), v: y }));
  const selected = open === 'month' ? month : open === 'day' ? day : year;

  return (
    <View style={{ width: '100%' }}>
      <View style={styles.row}>
        <Dropdown flex={1.6} placeholder="Month" label={month ? MONTHS[month - 1] : null} error={error} onPress={() => setOpen('month')} />
        <Dropdown flex={1} placeholder="Day" label={day ? String(day) : null} error={error} onPress={() => setOpen('day')} />
        <Dropdown flex={1.2} placeholder="Year" label={year ? String(year) : null} error={error} onPress={() => setOpen('year')} last />
      </View>

      <Modal visible={!!open} transparent animationType="fade" onRequestClose={() => setOpen(null)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(null)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>
              {open === 'month' ? 'Month' : open === 'day' ? 'Day' : 'Year'}
            </Text>
            <FlatList
              data={options}
              keyExtractor={o => String(o.v)}
              style={{ maxHeight: 340 }}
              initialNumToRender={31}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.option} onPress={() => pick(open, item.v)}>
                  <Text
                    style={[styles.optionText, item.v === selected && styles.optionTextActive]}
                    numberOfLines={1}
                  >
                    {item.label}
                  </Text>
                  {item.v === selected && <Ionicons name="checkmark" size={18} color={colors.primary} />}
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

function Dropdown({ flex, placeholder, label, error, onPress, last }) {
  return (
    <TouchableOpacity
      style={[styles.dropdown, { flex }, !last && { marginRight: 8 }, error ? styles.dropdownError : null]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <Text style={[styles.dropdownText, !label && styles.dropdownPlaceholder]} numberOfLines={1}>
        {label || placeholder}
      </Text>
      <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', width: '100%' },
  dropdown: {
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  dropdownError: { borderColor: colors.urgent },
  dropdownText: { fontSize: 15, color: colors.textPrimary, fontWeight: '500', flexShrink: 1, marginRight: 8, lineHeight: 20 },
  dropdownPlaceholder: { color: colors.textMuted, fontWeight: '400' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', paddingHorizontal: 36 },
  sheet: { backgroundColor: colors.surface, borderRadius: radii.lg, paddingVertical: 16, ...shadows.md },
  sheetTitle: {
    fontSize: 13, fontWeight: '600', color: colors.textMuted,
    paddingHorizontal: 20, paddingBottom: 8, lineHeight: 17,
  },
  option: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 12, paddingHorizontal: 20,
    borderTopWidth: 1, borderTopColor: colors.divider,
  },
  optionText: { fontSize: 15, color: colors.textPrimary, fontWeight: '500', flexShrink: 1, marginRight: 8, lineHeight: 20 },
  optionTextActive: { color: colors.primary, fontWeight: '600' },
});
