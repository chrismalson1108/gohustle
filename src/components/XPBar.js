import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, radii } from '../theme';

export default function XPBar({ levelInfo, xp, dark = true }) {
  const { current, next, progress } = levelInfo;
  const pct = Math.round(Math.min(1, progress) * 100);
  const label = dark ? '#fff' : colors.textPrimary;
  const muted = dark ? 'rgba(255,255,255,0.7)' : colors.textMuted;
  const track = dark ? 'rgba(255,255,255,0.24)' : colors.divider;
  const fill = dark ? '#fff' : colors.primary;

  return (
    <View>
      <View style={styles.row}>
        <Text style={[styles.label, { color: label }]} numberOfLines={1}>
          Lv.{current.level} · {current.label}
        </Text>
        <Text style={[styles.xp, { color: muted }]} numberOfLines={1}>
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
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  label: { fontSize: 13, fontWeight: '600', flexShrink: 1, marginRight: 8 },
  xp: { fontSize: 12, fontWeight: '500', flexShrink: 0 },
  track: { height: 6, borderRadius: radii.pill, overflow: 'hidden' },
  fill: { height: 6, borderRadius: radii.pill },
});
