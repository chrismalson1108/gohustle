import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme';

// Flat screen header — the replacement for the old gradient hero. Same children
// API as GradientHeader so screens migrate by swapping the tag and recoloring
// their text from white to ink.
//
// topInset={false} when an opaque native header already cleared the status bar,
// which is every pushed screen — only tab roots, which have no native bar, pay
// the inset themselves. (The old `underNav` prop went with the transparent hero
// header; that header was removed because its floating back button lost taps to
// the screen-edge gesture recogniser.)
export default function ScreenHeader({ children, style, topInset = true, surface = false }) {
  const insets = useSafeAreaInsets();
  const paddingTop = (topInset ? insets.top : 0) + 14;
  return (
    <View
      style={[
        styles.base,
        { paddingTop, backgroundColor: surface ? colors.surface : colors.background },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
});
