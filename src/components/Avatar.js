import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { colors } from '../theme';

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
  const radius = size / 2;
  const base = { width: size, height: size, borderRadius: radius, borderColor, borderWidth };

  if (url) {
    return <Image source={{ uri: url }} style={[base, styles.img, style]} />;
  }
  return (
    <View style={[base, styles.fallback, { backgroundColor: bg }, style]}>
      <Text style={{ color: textColor, fontWeight: '900', fontSize: fontSize || Math.round(size * 0.42) }}>
        {(initial || '?').toString().toUpperCase().slice(0, 1)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  img: { backgroundColor: colors.border },
  fallback: { alignItems: 'center', justifyContent: 'center' },
});
