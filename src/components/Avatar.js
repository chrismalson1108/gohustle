import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { colors, radii } from '../theme';

// Renders a user's photo when `url` is set, otherwise the initial-letter circle.
// Drop-in for every avatar site (sizes/colors vary by caller).
export default function Avatar({
  url,
  initial,
  size = 40,
  bg = colors.primary,
  textColor = '#fff',
  fontSize,
  borderColor,
  borderWidth = 0,
  style,
}) {
  // Avatars are true circles — radii.pill clamps to a circle for a square box.
  const base = {
    width: size,
    height: size,
    borderRadius: radii.pill,
    borderColor,
    borderWidth: Math.min(borderWidth, 1),
  };

  if (url) {
    return <Image source={{ uri: url }} style={[base, styles.img, style]} />;
  }
  return (
    <View style={[base, styles.fallback, { backgroundColor: bg }, style]}>
      <Text
        numberOfLines={1}
        style={{ color: textColor, fontWeight: '700', fontSize: fontSize || Math.round(size * 0.42) }}
      >
        {(initial || '?').toString().toUpperCase().slice(0, 1)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  img: { backgroundColor: colors.divider },
  fallback: { alignItems: 'center', justifyContent: 'center' },
});
