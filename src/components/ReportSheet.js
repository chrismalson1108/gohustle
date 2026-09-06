import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii } from '../theme';
import { REPORT_REASONS } from '../lib/moderation';

// The reason picker, shared. JobDetailScreen, PublicProfileScreen and MessageSheet each
// hand-rolled this same modal, and the browse card is the fourth caller — a fourth copy
// is how the five reasons drift into four on one surface.
//
// It is a <Modal> and NOT an Alert.alert on purpose: Alert caps at three buttons on
// Android and silently drops the rest, which is the bug the chat report flow already
// hit and fixed this way.
//
// `visible` is required. Every prop-shaped bug in this repo's sheets has been a caller
// that rendered one without it and wondered why nothing appeared.
export default function ReportSheet({ visible, title, subtitle, onSelect, onClose }) {
  // Cancel is the last row, so it lands in the home-indicator strip on a notched
  // phone without this — tappable in theory, swallowed by the system gesture in
  // practice. Found in the simulator: the tap did nothing until the inset was added.
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        {/* Swallow taps on the sheet itself — without this, choosing a reason near the
            sheet's padding closes the backdrop underneath instead. */}
        <TouchableOpacity
          style={[styles.sheet, { paddingBottom: 20 + Math.max(insets.bottom, 12) }]}
          activeOpacity={1}
          onPress={() => {}}
        >
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          {REPORT_REASONS.map((r) => (
            <TouchableOpacity key={r} style={styles.item} onPress={() => onSelect(r)}>
              <Text style={styles.itemText} numberOfLines={2}>{r}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={styles.cancel} onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 40, right: 40 }}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    paddingHorizontal: 20, paddingTop: 20,
  },
  title: { fontSize: 20, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.3, marginBottom: 8 },
  subtitle: { fontSize: 13.5, color: colors.textSecondary, lineHeight: 19, marginBottom: 4 },
  item: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.divider,
  },
  itemText: { fontSize: 15, fontWeight: '500', color: colors.textPrimary, lineHeight: 20, flexShrink: 1 },
  // A bare Text in a Touchable is only ~18pt tall — under half Apple's 44pt minimum,
  // and it sits at the very bottom of the sheet where the thumb is least accurate.
  // Measured in the simulator: taps 10pt below the glyphs did nothing.
  cancel: { marginTop: 12, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  cancelText: { fontSize: 15, fontWeight: '600', color: colors.textMuted },
});
