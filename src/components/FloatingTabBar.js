import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Animated, StyleSheet, Keyboard, Platform, PixelRatio } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, shadows } from '../theme';
import { useHaptic } from '../hooks/useHaptic';
import { tabBarProgress, expandTabBar, setChromeVisible } from '../lib/tabBarScroll';

// Each tab stack's hub (first) screen. The bar shows only on these; any other
// focused nested route means a pushed detail screen. Checked by NAME, not by
// index — a lazy-mounted tab reached via navigate('Tab', { screen: 'X' })
// without initial:false has X at index 0, which an index check would miss.
const HUB_ROUTES = new Set(['HomeMain', 'EarnMain', 'GigsMain', 'MessagesMain', 'ProfileMain']);

// Floating pill tab bar (Uber/IG style): hovers above the content so the list
// scrolls underneath it, expands to icons+labels when scrolling back up and
// shrinks to a compact icon pill when scrolling deeper (see lib/tabBarScroll).
// It also slides off-screen whenever the focused tab's stack is on a pushed
// detail screen, so bottom-pinned CTAs (JobDetail's Book bar, etc.) stay clear.
export default function FloatingTabBar({ state, descriptors, navigation }) {
  const insets = useSafeAreaInsets();
  const haptic = useHaptic();

  // Slide away while the keyboard is up — the absolute bar would otherwise
  // ride above it, covering content (Android 'resize' mode especially).
  const [kbVisible, setKbVisible] = useState(false);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, () => setKbVisible(true));
    const hide = Keyboard.addListener(hideEvt, () => setKbVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  // Arriving on a tab — by press, programmatic navigate, or notification tap —
  // always presents its hub at the top, so reset the shared progress. Also
  // covers remounts (sign-out/sign-in) inheriting stale compact state from the
  // module-level value.
  useEffect(() => { expandTabBar(); }, [state.index]);

  // A pushed/non-hub screen inside the focused tab's stack → hide the bar so it
  // never covers bottom-pinned CTAs (JobDetail's Book bar etc.).
  const focusedTab = state.routes[state.index];
  const nested = focusedTab.state;
  const nestedRoute = nested?.routes?.[nested.index ?? 0];
  const hidden = kbVisible || (nestedRoute ? !HUB_ROUTES.has(nestedRoute.name) : false);
  const hiddenAnim = useRef(new Animated.Value(0)).current;

  // The assistant FAB follows the bar so it can't cover form controls or a
  // bottom-pinned CTA on a pushed screen.
  useEffect(() => { setChromeVisible(!hidden); }, [hidden]);
  useEffect(() => {
    Animated.spring(hiddenAnim, {
      toValue: hidden ? 1 : 0,
      // Must match tabBarProgress's JS driver — this view also animates layout
      // props (left/right/padding), which the native driver can't handle, and
      // drivers can't be mixed on one view.
      useNativeDriver: false,
      tension: 90,
      friction: 14,
    }).start();
  }, [hidden, hiddenAnim]);

  const bottom = Math.max(insets.bottom, 16);
  const translateY = hiddenAnim.interpolate({ inputRange: [0, 1], outputRange: [0, bottom + 90] });
  const sideInset = tabBarProgress.interpolate({ inputRange: [0, 1], outputRange: [44, 20] });
  const padV = tabBarProgress.interpolate({ inputRange: [0, 1], outputRange: [8, 11] });
  // Scale the collapsing label row with the OS font size, or Larger Text
  // settings clip the labels against a fixed 15pt window.
  const labelHeight = Math.ceil(15 * Math.min(PixelRatio.getFontScale(), 1.6));
  const labelH = tabBarProgress.interpolate({ inputRange: [0, 1], outputRange: [0, labelHeight] });

  return (
    <Animated.View
      pointerEvents={hidden ? 'none' : 'auto'}
      style={[
        styles.bar,
        { bottom, left: sideInset, right: sideInset, paddingVertical: padV, transform: [{ translateY }] },
      ]}
    >
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const isFocused = state.index === index;
        const color = isFocused ? colors.primary : colors.textMuted;
        const badge = options.tabBarBadge;

        const onPress = () => {
          haptic.light();
          expandTabBar();
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!isFocused && !event.defaultPrevented) navigation.navigate(route.name);
        };
        const onLongPress = () => {
          navigation.emit({ type: 'tabLongPress', target: route.key });
        };
        const a11yLabel =
          `${options.tabBarAccessibilityLabel ?? options.title}, tab ${index + 1} of ${state.routes.length}` +
          (badge != null ? `, ${badge} new` : '');

        return (
          <TouchableOpacity
            key={route.key}
            style={styles.item}
            onPress={onPress}
            onLongPress={onLongPress}
            accessibilityRole="tab"
            accessibilityState={{ selected: isFocused }}
            accessibilityLabel={a11yLabel}
            testID={options.tabBarButtonTestID}
          >
            <View>
              {options.tabBarIcon?.({ focused: isFocused, color, size: 23 })}
              {badge != null && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{badge}</Text>
                </View>
              )}
            </View>
            <Animated.View style={{ height: labelH, opacity: tabBarProgress, overflow: 'hidden' }}>
              <Text style={[styles.label, { color }]} numberOfLines={1}>{options.title}</Text>
            </Animated.View>
          </TouchableOpacity>
        );
      })}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 999,
    paddingHorizontal: 8,
    ...shadows.md,
  },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 2 },
  label: { fontSize: 10.5, fontWeight: '600', marginTop: 2 },
  badge: {
    position: 'absolute', top: -4, right: -8,
    backgroundColor: colors.urgent, borderRadius: 8,
    minWidth: 15, minHeight: 15, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 3, paddingVertical: 1,
  },
  badgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },
});
