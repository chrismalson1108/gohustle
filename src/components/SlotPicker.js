import React from 'react';
import { ScrollView, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { colors } from '../theme';
import { useHaptic } from '../hooks/useHaptic';

export default function SlotPicker({ slots, selected, onSelect }) {
  const haptic = useHaptic();

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {slots.map(slot => {
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
            <Text style={[
              styles.chipText,
              isSelected && styles.chipTextSelected,
              slot.taken && styles.chipTextTaken,
            ]}>
              {slot.taken ? '🔒 ' : ''}{slot.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 4 },
  chip: {
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: colors.surface, marginRight: 10,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipTaken: { backgroundColor: colors.divider, borderColor: colors.divider, opacity: 0.6 },
  chipText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  chipTextSelected: { color: '#fff' },
  chipTextTaken: { color: colors.textMuted },
});
