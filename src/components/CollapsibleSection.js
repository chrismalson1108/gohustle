import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii } from '../theme';

// Extracted from EarnScreen so the You tab's Progress pane can reuse it verbatim.
// Kept as its own file rather than merged into a shared stylesheet: EarnScreen and
// ProfileScreen both define `section`/`breakdownRow`/`breakdownVal` with DIFFERENT
// values, so a merged sheet would silently reskin whichever screen lost the collision.
export default function CollapsibleSection({ title, open, onToggle, children }) {
  return (
    <View>
      <TouchableOpacity style={styles.header} onPress={onToggle} activeOpacity={0.7}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textMuted} />
      </TouchableOpacity>
      {open && <View style={styles.body}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginHorizontal: 16, marginTop: 24,
    backgroundColor: colors.surface, borderRadius: radii.md,
    paddingHorizontal: 16, paddingVertical: 14,
    borderWidth: 1, borderColor: colors.border,
  },
  title: { fontSize: 15, fontWeight: '700', color: colors.textPrimary, flexShrink: 1, marginRight: 12 },
  body: { marginTop: 4, marginBottom: 4 },
});
