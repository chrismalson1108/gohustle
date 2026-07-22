import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii } from '../theme';

// Free-form tag editor: type + return (or blur) adds a chip; tap a chip to remove.
// Used by PostJob and EditJob for jobs.tags. Tags help discovery + "For You" matching.
export default function TagInput({ value = [], onChange, max = 6, placeholder = 'e.g. lawncare, assembly' }) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const t = draft.trim().toLowerCase().slice(0, 24);
    if (t && !value.includes(t) && value.length < max) onChange([...value, t]);
    setDraft('');
  };
  const remove = (t) => onChange(value.filter((x) => x !== t));

  return (
    <View style={styles.wrap}>
      {value.map((t) => (
        <TouchableOpacity key={t} style={styles.chip} onPress={() => remove(t)} activeOpacity={0.7}>
          <Text style={styles.chipText} numberOfLines={1}>{t}</Text>
          <Ionicons name="close" size={13} color={colors.primary} style={styles.chipClose} />
        </TouchableOpacity>
      ))}
      {value.length < max && (
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={add}
          onBlur={add}
          blurOnSubmit={false}
          returnKeyType="done"
          autoCapitalize="none"
          placeholder={value.length ? 'Add another…' : placeholder}
          placeholderTextColor={colors.textMuted}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primaryLight,
    borderRadius: radii.pill, paddingHorizontal: 12, paddingVertical: 8,
    alignSelf: 'flex-start', maxWidth: '100%',
  },
  chipText: { fontSize: 13, fontWeight: '600', color: colors.primary, flexShrink: 1, lineHeight: 17 },
  chipClose: { marginLeft: 6, flexShrink: 0 },
  input: {
    flexGrow: 1, minWidth: 140, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.textPrimary,
  },
});
