import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function XPBar({ levelInfo, xp, dark = true }) {
  const { current, next, progress } = levelInfo;
  const pct = Math.round(Math.min(1, progress) * 100);
  const txt = dark ? '#fff' : '#181231';
  const muted = dark ? 'rgba(255,255,255,0.6)' : '#6B7280';
  const track = dark ? 'rgba(255,255,255,0.2)' : '#E5E7EB';
  const fill = dark ? '#fff' : '#3F25FE';

  return (
    <View>
      <View style={styles.row}>
        <Text style={[styles.label, { color: dark ? 'rgba(255,255,255,0.9)' : '#3F25FE' }]}>
          Lv.{current.level} · {current.label}
        </Text>
        <Text style={[styles.xp, { color: muted }]}>
          {xp} / {next.minXP} XP
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: track }]}>
        <View style={[styles.fill, { width: `${pct}%`, backgroundColor: fill }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 },
  label: { fontSize: 12, fontWeight: '700' },
  xp: { fontSize: 11, fontWeight: '500' },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
});
