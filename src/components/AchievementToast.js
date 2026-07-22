import React, { useEffect, useRef } from 'react';
import { Animated, View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useUser } from '../context/UserContext';
import { colors, radii, shadows } from '../theme';

// Map the emoji callers pass to showToast({ icon }) onto vector icons, so toasts
// render reliably (emoji can fail to render on some simulators/devices).
// Colors are semantic only: success = done/paid, urgent = failed/removed,
// accentDeep = money/energy highlight, primary = neutral app action.
const ICONS = {
  '✅': { name: 'checkmark-circle', color: colors.success },
  '🎉': { name: 'trophy',           color: colors.accentDeep },
  '⭐': { name: 'star',             color: colors.accentDeep },
  '🌟': { name: 'star',             color: colors.accentDeep },
  '🔥': { name: 'flame',            color: colors.accentDeep },
  '💰': { name: 'cash',             color: colors.success },
  '💵': { name: 'cash',             color: colors.success },
  '💳': { name: 'card',             color: colors.primary },
  '⚡': { name: 'flash',            color: colors.accentDeep },
  '⚠️': { name: 'warning',          color: colors.accentDeep },
  '❌': { name: 'close-circle',     color: colors.urgent },
  '🗑️': { name: 'trash',            color: colors.urgent },
  '💚': { name: 'checkmark-done-circle', color: colors.success },
  '😔': { name: 'sad',              color: colors.textMuted },
  '🔔': { name: 'notifications',    color: colors.accentDeep },
  '✏️': { name: 'create',           color: colors.primary },
  '🚀': { name: 'rocket',           color: colors.primary },
  '📝': { name: 'document-text',    color: colors.primary },
  '🔑': { name: 'key',              color: colors.accentDeep },
  '🎯': { name: 'locate',           color: colors.primary },
  '💻': { name: 'laptop',           color: colors.primary },
};

export default function AchievementToast() {
  const { pendingToast, dismissToast } = useUser();
  const insets = useSafeAreaInsets();
  const ty = useRef(new Animated.Value(-120)).current;
  const op = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!pendingToast) return;
    Animated.parallel([
      Animated.spring(ty, { toValue: 0, useNativeDriver: true, tension: 55, friction: 9 }),
      Animated.timing(op, { toValue: 1, duration: 250, useNativeDriver: true }),
    ]).start();
    const t = setTimeout(() => {
      Animated.parallel([
        Animated.timing(ty, { toValue: -120, duration: 300, useNativeDriver: true }),
        Animated.timing(op, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start(() => dismissToast());
    }, 3000);
    return () => clearTimeout(t);
  }, [pendingToast]);

  if (!pendingToast) return null;

  const ic = ICONS[pendingToast.icon] || { name: 'notifications', color: colors.primary };

  return (
    <Animated.View
      style={[styles.toast, { top: insets.top + 8, transform: [{ translateY: ty }], opacity: op }]}
    >
      <View style={styles.iconWrap}>
        <Ionicons name={ic.name} size={22} color={ic.color} />
      </View>
      <View style={styles.textWrap}>
        <Text style={styles.title} numberOfLines={1}>{pendingToast.title}</Text>
        <Text style={styles.msg} numberOfLines={2}>{pendingToast.message}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute', left: 20, right: 20,
    backgroundColor: colors.surface,
    borderRadius: radii.lg, padding: 16,
    flexDirection: 'row', alignItems: 'center',
    zIndex: 9999,
    ...shadows.md,
  },
  iconWrap: {
    width: 38, height: 38, borderRadius: radii.pill,
    backgroundColor: colors.background,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 12, flexShrink: 0,
  },
  textWrap: { flex: 1 },
  title: { fontSize: 14, fontWeight: '700', color: colors.textPrimary, marginBottom: 2, letterSpacing: -0.2 },
  msg: { fontSize: 13, fontWeight: '400', color: colors.textSecondary, lineHeight: 18 },
});
