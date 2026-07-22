import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import Avatar from '../components/Avatar';
import RatingStars from '../components/RatingStars';
import { useAuth } from '../context/AuthContext';
import { fetchFavorites } from '../lib/favorites';
import { colors, radii, shadows } from '../theme';

export default function FavoritesScreen({ navigation }) {
  const { user } = useAuth();
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try { setPeople(await fetchFavorites(user.id)); } catch (_) {}
    setLoading(false);
  }, [user?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  if (loading) return <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scroll}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      {people.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="heart-outline" size={44} color={colors.textMuted} style={{ marginBottom: 12 }} />
          <Text style={styles.emptyTitle}>No saved people yet</Text>
          <Text style={styles.emptyText}>Open someone's profile and tap the heart to save them here for quick re-hiring.</Text>
        </View>
      ) : people.map(p => (
        <TouchableOpacity key={p.id} style={styles.row} onPress={() => navigation.navigate('UserProfile', { userId: p.id })} activeOpacity={0.85}>
          <Avatar url={p.avatar_url} initial={p.avatar_initial || p.name?.[0]} size={44} fontSize={17} style={{ marginRight: 12 }} />
          <View style={styles.rowBody}>
            <Text style={styles.name} numberOfLines={1}>{p.name || 'User'}</Text>
            {p.review_count > 0
              ? <RatingStars rating={p.rating} size={12} />
              : <Text style={styles.sub} numberOfLines={1}>No reviews yet</Text>}
            {p.city ? <Text style={styles.sub} numberOfLines={1}>{p.city}</Text> : null}
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} style={styles.chevron} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { paddingHorizontal: 20, paddingVertical: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 56 },
  emptyTitle: { fontSize: 17, fontWeight: '700', color: colors.textPrimary, marginBottom: 8, letterSpacing: -0.2, lineHeight: 22 },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 21 },
  row: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: radii.lg, padding: 16, marginBottom: 12, ...shadows.card,
  },
  rowBody: { flex: 1, marginRight: 12 },
  name: { fontSize: 15, fontWeight: '700', color: colors.textPrimary, marginBottom: 2, lineHeight: 20 },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 2, lineHeight: 16 },
  chevron: { flexShrink: 0 },
});
