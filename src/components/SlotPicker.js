import React from 'react';
import { ScrollView, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii } from '../theme';
import { useHaptic } from '../hooks/useHaptic';

export default function SlotPicker({ slots, selected, onSelect }) {
  const haptic = useHaptic();

  // Hide dated slots whose time has already passed (flexible/undated slots stay)
  const now = Date.now();
  const visible = slots.filter(s => !s.startsAt || new Date(s.startsAt).getTime() > now);

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {visible.map(slot => {
        const isSelected = selected === slot.id;
        return (
          <TouchableOpacity
            key={slot.id}
            disabled={slot.taken}
            onPress={() => { haptic.selection(); onSelect(slot.id); }}
            style={[
              styles.chip,
              isSelected && styles.chipSelected,
              slot.taken && styles.chipTaken,
            ]}
          >
            {slot.taken && (
              <Ionicons name="lock-closed" size={13} color={colors.textSecondary} style={{ marginRight: 5 }} />
            )}
            <Text
              numberOfLines={1}
              style={[
                styles.chipText,
                isSelected && styles.chipTextSelected,
                slot.taken && styles.chipTextTaken,
              ]}
            >
              {slot.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 4, alignItems: 'center' },
  chip: {
    borderRadius: radii.pill, paddingHorizontal: 16, paddingVertical: 10,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, marginRight: 8,
    maxWidth: 280,
    flexDirection: 'row', alignItems: 'center',
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  // Disabled state reads through color alone — stacking opacity on top faded the
  // label into the fill and made taken slots unreadable.
  chipTaken: { backgroundColor: colors.divider, borderColor: colors.divider },
  chipText: { fontSize: 13, fontWeight: '500', color: colors.textSecondary, lineHeight: 17, flexShrink: 1 },
  chipTextSelected: { color: '#fff', fontWeight: '600' },
  chipTextTaken: { color: colors.textSecondary },
});
