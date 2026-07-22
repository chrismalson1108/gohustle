import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from '../theme';

export default function RatingStars({ rating, size = 13 }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.star, { fontSize: size }]} numberOfLines={1}>★</Text>
      <Text style={[styles.value, { fontSize: size }]} numberOfLines={1}>
        {rating.toFixed(1)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  // Amber star is the rating convention; the ink-colored number carries the value
  // so the meaning never depends on the low-contrast glyph alone.
  star: { color: colors.accent, marginRight: 4, flexShrink: 0 },
  value: { fontWeight: '600', color: colors.textPrimary, flexShrink: 0 },
});
