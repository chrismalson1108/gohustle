import React, { useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import ScreenHeader from '../components/ScreenHeader';
import { BADGE_DEFS, BADGE_GROUPS } from '../data/mockData';
import { badgeStatus } from '../../shared/badges.js';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { colors, radii } from '../theme';

// Every badge, grouped, with earned ones lit and locked ones showing live
// progress ("3 / 10 gigs") so the collection reads as a goal, not a wall.
export default function TrophyCaseScreen({ route }) {
  const {
    badges, earningsTotal, streakDays, verified, avatarUrl, bio, skills,
  } = useUser();
  const { bookings, posterBookings, postedJobs } = useJobs();
  const reviews = route?.params?.reviews;
  const referrals = route?.params?.referrals;

  const ctx = useMemo(() => ({
    bookings, posterBookings, postedJobs,
    earningsTotal, streakDays, verified, avatarUrl, bio, skills,
    reviews, referrals,
  }), [bookings, posterBookings, postedJobs, earningsTotal, streakDays, verified, avatarUrl, bio, skills, reviews, referrals]);

  const keys = Object.keys(BADGE_DEFS);
  const earnedCount = keys.filter(k => badges?.[k]?.unlocked).length;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
      <ScreenHeader underNav>
        <Text style={styles.title} numberOfLines={1}>Trophy case</Text>
        <Text style={styles.sub} numberOfLines={1}>{earnedCount} of {keys.length} badges unlocked</Text>
      </ScreenHeader>

      {BADGE_GROUPS.map(group => {
        const inGroup = keys.filter(k => BADGE_DEFS[k].group === group.id);
        if (inGroup.length === 0) return null;
        // Earned first so progress feels front-loaded.
        const ordered = [
          ...inGroup.filter(k => badges?.[k]?.unlocked),
          ...inGroup.filter(k => !badges?.[k]?.unlocked),
        ];
        return (
          <View key={group.id} style={styles.section}>
            <Text style={styles.sectionTitle} numberOfLines={1}>{group.label}</Text>
            {ordered.map(key => {
              const def = BADGE_DEFS[key];
              const unlocked = !!badges?.[key]?.unlocked;
              const status = unlocked ? null : badgeStatus(key, ctx);
              const showBar = !unlocked && status?.target > 1 && status.current > 0;
              return (
                <View key={key} style={styles.row}>
                  <View style={[styles.iconWrap, unlocked ? styles.iconWrapOn : styles.iconWrapOff]}>
                    <Ionicons
                      name={unlocked ? def.ion : 'lock-closed'}
                      size={20}
                      color={unlocked ? colors.accentDeep : colors.textMuted}
                    />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={[styles.name, !unlocked && styles.nameLocked]} numberOfLines={1}>{def.label}</Text>
                    <Text style={styles.desc} numberOfLines={2}>{def.desc}</Text>
                    {showBar && (
                      <View style={styles.progressWrap}>
                        <View style={styles.track}>
                          <View style={[styles.fill, { width: `${Math.min(100, (status.current / status.target) * 100)}%` }]} />
                        </View>
                        <Text style={styles.progressText} numberOfLines={1}>
                          {formatProgress(status.current)} / {formatProgress(status.target)}
                        </Text>
                      </View>
                    )}
                  </View>
                  {unlocked && (
                    <Ionicons name="checkmark-circle" size={18} color={colors.success} style={styles.check} />
                  )}
                </View>
              );
            })}
          </View>
        );
      })}
    </ScrollView>
  );
}

// Earnings targets read better abbreviated than as raw counts.
function formatProgress(n) {
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`;
  return String(Math.round(n));
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  title: { fontSize: 26, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.5 },
  sub: { fontSize: 14, color: colors.textSecondary, marginTop: 2 },
  section: { paddingHorizontal: 20, marginTop: 20 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 10 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radii.lg,
    padding: 14, marginBottom: 8,
  },
  iconWrap: {
    width: 42, height: 42, borderRadius: radii.pill,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 12, flexShrink: 0,
  },
  iconWrapOn: { backgroundColor: colors.accentLight },
  iconWrapOff: { backgroundColor: colors.background },
  rowText: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  nameLocked: { color: colors.textSecondary },
  desc: { fontSize: 12, color: colors.textMuted, marginTop: 2, lineHeight: 17 },
  progressWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  track: { flex: 1, height: 5, borderRadius: radii.pill, backgroundColor: colors.divider, overflow: 'hidden' },
  fill: { height: 5, borderRadius: radii.pill, backgroundColor: colors.primary },
  progressText: { fontSize: 11, fontWeight: '600', color: colors.textMuted, flexShrink: 0 },
  check: { marginLeft: 10, flexShrink: 0 },
});
