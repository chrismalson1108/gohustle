import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import Avatar from '../components/Avatar';
import RatingStars from '../components/RatingStars';
import { useAuth } from '../context/AuthContext';
import { fetchFavorites } from '../lib/favorites';
import { colors, shadows } from '../theme';

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
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      {people.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="heart-outline" size={48} color={colors.textMuted} style={{ marginBottom: 12 }} />
          <Text style={styles.emptyTitle}>No saved people yet</Text>
          <Text style={styles.emptyText}>Open someone's profile and tap the heart to save them here for quick re-hiring.</Text>
        </View>
      ) : people.map(p => (
        <TouchableOpacity key={p.id} style={styles.row} onPress={() => navigation.navigate('UserProfile', { userId: p.id })} activeOpacity={0.85}>
          <Avatar url={p.avatar_url} initial={p.avatar_initial || p.name?.[0]} size={44} fontSize={17} style={{ marginRight: 12 }} />
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{p.name || 'User'}</Text>
            {p.review_count > 0
              ? <RatingStars rating={p.rating} size={12} />
              : <Text style={styles.sub}>No reviews yet</Text>}
            {p.city ? <Text style={styles.sub}>{p.city}</Text> : null}
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 60 },
  emptyTitle: { fontSize: 17, fontWeight: '800', color: colors.textPrimary, marginBottom: 8 },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  row: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: 14, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  name: { fontSize: 15, fontWeight: '800', color: colors.textPrimary, marginBottom: 2 },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
});
