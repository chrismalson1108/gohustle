import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import RatingStars from './RatingStars';
import Avatar from './Avatar';
import StudentBadge from './StudentBadge';
import { collegeLine } from '../lib/school';
import { colors, radii, shadows } from '../theme';

export default function PosterTrustCard({ poster }) {
  const college = collegeLine(poster);
  return (
    <View style={styles.card}>
      <Avatar url={poster.avatarUrl} initial={poster.avatarInitial} size={52} fontSize={20} style={{ marginRight: 12 }} />
      <View style={styles.info}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>{poster.name}</Text>
          {poster.verified && (
            <View style={styles.verifiedBadge}>
              <Ionicons name="checkmark-circle" size={11} color={colors.success} style={{ marginRight: 3 }} />
              <Text style={styles.verifiedText} numberOfLines={1}>Verified</Text>
            </View>
          )}
          <StudentBadge profile={poster} compact style={{ marginLeft: 6 }} />
        </View>
        {!!college && <Text style={styles.college} numberOfLines={1}>{college}</Text>}
        {poster.reviewCount > 0 ? (
          <>
            <RatingStars rating={poster.rating} />
            <Text style={[styles.sub, styles.subSpaced]} numberOfLines={1}>{poster.reviewCount} review{poster.reviewCount !== 1 ? 's' : ''}</Text>
          </>
        ) : (
          <View style={styles.newRow}>
            <Ionicons name="sparkles-outline" size={12} color={colors.textMuted} style={{ marginRight: 4 }} />
            <Text style={styles.sub} numberOfLines={1}>New · no reviews yet</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: 16,
    ...shadows.card,
  },
  info: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  name: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, marginRight: 8, flexShrink: 1, letterSpacing: -0.2 },
  verifiedBadge: {
    backgroundColor: colors.successLight,
    borderRadius: radii.sm,
    paddingHorizontal: 8, paddingVertical: 3,
    flexDirection: 'row', alignItems: 'center',
    alignSelf: 'flex-start', flexShrink: 0,
  },
  verifiedText: { fontSize: 11, fontWeight: '600', color: colors.success },
  college: { fontSize: 12, color: colors.textSecondary, marginBottom: 4, fontWeight: '500' },
  sub: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  subSpaced: { marginTop: 4 },
  newRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
});
