import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Avatar from './Avatar';
import { colors, radii } from '../theme';

// One received review. Shared by ProfileScreen (most recent few) and
// ReviewsScreen (the full list) so both render identically.
export default function ReviewCard({ review: r }) {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Avatar
          url={r.reviewer?.avatar_url}
          initial={r.reviewer?.avatar_initial || r.author?.[0]}
          size={36}
          fontSize={14}
          style={{ marginRight: 12 }}
        />
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>{r.reviewer?.name || r.author || 'Poster'}</Text>
          <View style={styles.starsRow}>
            {[1, 2, 3, 4, 5].map(s => (
              <Ionicons
                key={s}
                name={s <= Math.round(r.rating) ? 'star' : 'star-outline'}
                size={12}
                color={s <= Math.round(r.rating) ? colors.accent : colors.border}
                style={styles.star}
              />
            ))}
            <Text style={styles.ratingNum}>{Number(r.rating).toFixed(1)}</Text>
          </View>
        </View>
        {r.date && <Text style={styles.date} numberOfLines={1}>{r.date}</Text>}
      </View>
      {r.text ? <Text style={styles.text}>{r.text}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: 14,
    marginBottom: 10,
  },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  info: { flex: 1, minWidth: 0, marginRight: 8 },
  name: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  starsRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  star: { marginRight: 1 },
  ratingNum: { fontSize: 12, color: colors.textMuted, marginLeft: 6 },
  date: { fontSize: 11, color: colors.textMuted, flexShrink: 0 },
  text: { fontSize: 13, color: colors.textSecondary, lineHeight: 20 },
});
