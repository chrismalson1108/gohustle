import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { colors, radii } from '../theme';
import { safeStorageUrl } from '../../shared/transforms.js';

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

  // Never render a URL that is not an object in our own avatars bucket. avatar_url is
  // owner-writable free text, so a direct API write could point this at any host —
  // unmoderated (moderate-image only ever sees bucket objects) and a beacon that logs
  // every viewer's IP. 20260906014100 refuses such writes; this refuses to render the
  // rows that predate it. Falls back to the initial circle, which is what an empty
  // avatar has always looked like.
  const safeUrl = safeStorageUrl(url, 'avatars');
  if (safeUrl) {
    return <Image source={{ uri: safeUrl }} style={[base, styles.img, style]} />;
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
