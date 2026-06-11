import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import RatingStars from './RatingStars';
import { colors, shadows } from '../theme';

export default function PosterTrustCard({ poster }) {
  return (
    <View style={styles.card}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{poster.avatarInitial}</Text>
      </View>
      <View style={styles.info}>
        <View style={styles.nameRow}>
          <Text style={styles.name}>{poster.name}</Text>
          {poster.verified && (
            <View style={styles.verifiedBadge}>
              <Text style={styles.verifiedText}>✓ Verified</Text>
            </View>
          )}
        </View>
        <RatingStars rating={poster.rating} />
        <Text style={styles.sub}>{poster.reviewCount} reviews as employer</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  avatar: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 14,
  },
  avatarText: { color: '#fff', fontWeight: '800', fontSize: 20 },
  info: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  name: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, marginRight: 8 },
  verifiedBadge: {
    backgroundColor: '#ECFDF5',
    borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
  },
  verifiedText: { fontSize: 11, fontWeight: '700', color: colors.success },
  sub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
});
