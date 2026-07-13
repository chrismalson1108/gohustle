import React from 'react';
import { StyleSheet, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const NAV_BAR_HEIGHT = Platform.OS === 'ios' ? 44 : 56;

export default function GradientHeader({ colors, children, style, topInset = true, underNav = false }) {
  const insets = useSafeAreaInsets();
  // underNav: the screen uses a TRANSPARENT native header (hero pattern) — the
  // gradient runs to the very top of the screen and content clears the floating
  // back button. Otherwise: pad for the status bar unless topInset is false.
  const paddingTop = underNav
    ? insets.top + NAV_BAR_HEIGHT + 6
    : (topInset ? insets.top : 0) + 16;
  return (
    <LinearGradient
      colors={colors}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.base, { paddingTop }, style]}
    >
      {children}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  base: {
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
});
