import { useRef, useCallback } from 'react';
import { Animated } from 'react-native';

// Shared scroll-direction state driving FloatingTabBar's expand/collapse.
// 1 = expanded (icons + labels), 0 = compact (icons only). Hub screens attach
// the handler from useTabBarScrollHandler() to their main scroll view's
// onScroll (with scrollEventThrottle set); the bar springs between states on
// direction changes rather than tracking offset continuously.
export const tabBarProgress = new Animated.Value(1);

let current = 1;
function animateTo(v) {
  if (current === v) return;
  current = v;
  Animated.spring(tabBarProgress, {
    toValue: v,
    // Drives layout props (left/right/label height), not just transforms.
    useNativeDriver: false,
    tension: 90,
    friction: 13,
  }).start();
}

export function expandTabBar() { animateTo(1); }

export function useTabBarScrollHandler() {
  const lastY = useRef(0);
  return useCallback((e) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const y = contentOffset.y;
    // Clamp: content shorter than the viewport makes the raw value negative,
    // which would send every event (even y=0) into the overscroll guard and
    // leave the bar stuck compact.
    const maxY = Math.max(0, contentSize.height - layoutMeasurement.height);
    const dy = y - lastY.current;
    lastY.current = y;
    // Ignore rubber-band overscroll so the bar doesn't flicker at the edges.
    if (y < 0 || y > maxY) return;
    // Near the top there's nothing hidden behind the bar — always show it full.
    if (y <= 32) { animateTo(1); return; }
    if (dy > 3) animateTo(0);        // scrolling deeper into the list → compact
    else if (dy < -3) animateTo(1);  // scrolling back toward the top → expanded
  }, []);
}
