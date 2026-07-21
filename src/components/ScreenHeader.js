import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../theme';

const NAV_BAR_HEIGHT = Platform.OS === 'ios' ? 44 : 56;

// Flat screen header — the replacement for the old gradient hero. Same children
// API as GradientHeader so screens migrate by swapping the tag and recoloring
// their text from white to ink.
//
// underNav: the screen uses a TRANSPARENT native header, so content must clear
// the floating back button. topInset={false} when a native opaque header
// already handled the status bar.
export default function ScreenHeader({ children, style, topInset = true, underNav = false, surface = false }) {
  const insets = useSafeAreaInsets();
  const paddingTop = underNav
    ? insets.top + NAV_BAR_HEIGHT + 6
    : (topInset ? insets.top : 0) + 14;
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
