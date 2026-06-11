import React, { useEffect, useRef } from 'react';
import { Animated, View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUser } from '../context/UserContext';

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

  return (
    <Animated.View
      style={[styles.toast, { top: insets.top + 8, transform: [{ translateY: ty }], opacity: op }]}
    >
      <Text style={styles.icon}>{pendingToast.icon}</Text>
      <View>
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
  icon: { fontSize: 30, marginRight: 14 },
  title: { fontSize: 12, fontWeight: '700', color: '#F59E0B', marginBottom: 2 },
  msg: { fontSize: 14, fontWeight: '700', color: '#fff' },
});
