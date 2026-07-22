import React, { useState, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import ScreenHeader from '../components/ScreenHeader';
import ReviewCard from '../components/ReviewCard';
import { useHaptic } from '../hooks/useHaptic';
import { colors, radii } from '../theme';

const TABS = [
  { id: 'all',    label: 'All' },
  { id: 'earner', label: 'As a worker' },
  { id: 'poster', label: 'As a client' },
];

// The full review history, split by the role the review was left for. Profile
// links here once a user has more reviews than it shows inline.
export default function ReviewsScreen({ route }) {
  const all = route?.params?.reviews || [];
  const [tab, setTab] = useState('all');
  const haptic = useHaptic();

  const shown = useMemo(
    () => (tab === 'all' ? all : all.filter(r => r.role === tab)),
    [all, tab],
  );

  const avg = shown.length
    ? (shown.reduce((s, r) => s + (r.rating || 0), 0) / shown.length).toFixed(1)
    : '—';

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
      <ScreenHeader underNav>
        <Text style={styles.title} numberOfLines={1}>Reviews</Text>
        <Text style={styles.sub} numberOfLines={1}>
          {avg !== '—' ? `${avg} average · ` : ''}{shown.length} review{shown.length === 1 ? '' : 's'}
        </Text>
      </ScreenHeader>

      <View style={styles.tabs}>
        {TABS.map(t => {
          const active = tab === t.id;
          const count = t.id === 'all' ? all.length : all.filter(r => r.role === t.id).length;
          return (
            <TouchableOpacity
              key={t.id}
              style={[styles.tab, active && styles.tabActive]}
              onPress={() => { haptic.selection(); setTab(t.id); }}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]} numberOfLines={1}>
                {t.label} {count > 0 ? `(${count})` : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.list}>
        {shown.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="star-outline" size={30} color={colors.accent} />
            <Text style={styles.emptyTitle} numberOfLines={1}>No reviews here yet</Text>
            <Text style={styles.emptyText}>
              {tab === 'poster'
                ? 'Reviews from hustlers you hire will show up here.'
                : 'Finish a gig to start collecting reviews.'}
            </Text>
          </View>
        ) : (
          shown.map(r => <ReviewCard key={r.id} review={r} />)
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  title: { fontSize: 26, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.5 },
  sub: { fontSize: 14, color: colors.textSecondary, marginTop: 2 },
  tabs: {
    flexDirection: 'row', marginHorizontal: 20, marginTop: 4,
    backgroundColor: colors.surface, borderRadius: radii.pill, padding: 4,
    borderWidth: 1, borderColor: colors.border,
  },
  tab: { flex: 1, paddingVertical: 9, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  tabActive: { backgroundColor: colors.primary },
  tabText: { fontSize: 12.5, fontWeight: '600', color: colors.textSecondary, flexShrink: 1 },
  tabTextActive: { color: '#fff' },
  list: { paddingHorizontal: 20, marginTop: 16 },
  empty: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 20, gap: 8 },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: colors.textPrimary },
  emptyText: { fontSize: 13, color: colors.textSecondary, textAlign: 'center', lineHeight: 19 },
});
