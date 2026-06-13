import React, { useEffect, useRef } from 'react';
import { Animated, View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useUser } from '../context/UserContext';

// Map the emoji callers pass to showToast({ icon }) onto vector icons, so toasts
// render reliably (emoji can fail to render on some simulators/devices).
const ICONS = {
  '✅': { name: 'checkmark-circle', color: '#10B981' },
  '🎉': { name: 'trophy',           color: '#F59E0B' },
  '⭐': { name: 'star',             color: '#F59E0B' },
  '🌟': { name: 'star',             color: '#F59E0B' },
  '🔥': { name: 'flame',            color: '#F97316' },
  '💰': { name: 'cash',             color: '#10B981' },
  '💵': { name: 'cash',             color: '#10B981' },
  '💳': { name: 'card',             color: '#A78BFA' },
  '⚡': { name: 'flash',            color: '#F59E0B' },
  '⚠️': { name: 'warning',          color: '#F59E0B' },
  '❌': { name: 'close-circle',     color: '#EF4444' },
  '🗑️': { name: 'trash',            color: '#EF4444' },
  '💚': { name: 'checkmark-done-circle', color: '#10B981' },
  '😔': { name: 'sad',              color: '#9CA3AF' },
  '🔔': { name: 'notifications',    color: '#F59E0B' },
  '✏️': { name: 'create',           color: '#A78BFA' },
  '🚀': { name: 'rocket',           color: '#A78BFA' },
  '📝': { name: 'document-text',    color: '#A78BFA' },
  '🔑': { name: 'key',              color: '#F59E0B' },
  '🎯': { name: 'locate',           color: '#A78BFA' },
  '💻': { name: 'laptop',           color: '#A78BFA' },
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

  const ic = ICONS[pendingToast.icon] || { name: 'notifications', color: '#F59E0B' };

  return (
    <Animated.View
      style={[styles.toast, { top: insets.top + 8, transform: [{ translateY: ty }], opacity: op }]}
    >
      <View style={styles.iconWrap}>
        <Ionicons name={ic.name} size={24} color={ic.color} />
      </View>
      <View style={styles.textWrap}>
        <Text style={styles.title}>{pendingToast.title}</Text>
        <Text style={styles.msg}>{pendingToast.message}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute', left: 16, right: 16,
    backgroundColor: '#1E1B4B',
    borderRadius: 18, padding: 16,
    flexDirection: 'row', alignItems: 'center',
    zIndex: 9999,
    shadowColor: '#000', shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35, shadowRadius: 20, elevation: 12,
  },
  iconWrap: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center', justifyContent: 'center',
    marginRight: 12,
  },
  textWrap: { flex: 1 },
  title: { fontSize: 12, fontWeight: '700', color: '#F59E0B', marginBottom: 2 },
  msg: { fontSize: 14, fontWeight: '700', color: '#fff' },
});
