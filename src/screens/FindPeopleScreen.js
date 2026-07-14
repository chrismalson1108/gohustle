import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator, Keyboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useJobs } from '../context/JobsContext';
import { useHaptic } from '../hooks/useHaptic';
import Avatar from '../components/Avatar';
import RatingStars from '../components/RatingStars';
import { colors, shadows } from '../theme';

const DEBOUNCE_MS = 350;
const MIN_QUERY = 2;

// Search people by name or @username → tap through to their public profile
// (message / invite / favorite live there). Reachable from the Profile tab
// ("Find People") and the Messages header search icon.
export default function FindPeopleScreen({ navigation }) {
  const { user } = useAuth();
  const { blockedIds } = useJobs();
  const haptic = useHaptic();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null); // null = nothing searched yet
  const [searching, setSearching] = useState(false);
  const timer = useRef(null);
  const seq = useRef(0);

  const runSearch = async (raw) => {
    // Leading @ is how usernames are displayed — accept it. Strip characters
    // that are ilike wildcards or would break the PostgREST or() syntax.
    const q = raw.trim().replace(/^@/, '').replace(/[%_,()]/g, '');
    if (q.length < MIN_QUERY) { setResults(null); setSearching(false); return; }
    const mySeq = ++seq.current;
    setSearching(true);
    const { data } = await supabase
      .from('profiles')
      .select('id, name, username, avatar_initial, avatar_url, rating, review_count, verified, city, skills')
      .or(`username.ilike.%${q}%,name.ilike.%${q}%`)
      .not('username', 'is', null) // only users who finished onboarding
      .order('review_count', { ascending: false })
      .limit(25);
    if (mySeq !== seq.current) return; // a newer query superseded this one
    const list = (data || []).filter(p => p.id !== user?.id && !blockedIds?.has(p.id));
    setResults(list);
    setSearching(false);
  };

  const onChange = (v) => {
    setQuery(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => runSearch(v), DEBOUNCE_MS);
  };

  const openProfile = (p) => {
    haptic.light();
    Keyboard.dismiss();
    navigation.navigate('UserProfile', { userId: p.id });
  };

  return (
    <View style={styles.container}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textMuted} style={{ marginRight: 8 }} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name or @username"
          placeholderTextColor={colors.textMuted}
          value={query}
          onChangeText={onChange}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          returnKeyType="search"
          onSubmitEditing={() => runSearch(query)}
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => { setQuery(''); setResults(null); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {searching ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 32 }} />
      ) : results === null ? (
        <View style={styles.empty}>
          <View style={styles.emptyIconWrap}>
            <Ionicons name="people-outline" size={30} color={colors.primary} />
          </View>
          <Text style={styles.emptyTitle}>Find people on GoHustlr</Text>
          <Text style={styles.emptyText}>
            Search workers and clients by name or username, then view their profile to message, invite, or favorite them.
          </Text>
        </View>
      ) : results.length === 0 ? (
        <View style={styles.empty}>
          <View style={styles.emptyIconWrap}>
            <Ionicons name="search-outline" size={30} color={colors.primary} />
          </View>
          <Text style={styles.emptyTitle}>No one found</Text>
          <Text style={styles.emptyText}>Nobody matches "{query.trim()}". Check the spelling or try a different name.</Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={p => p.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingTop: 4, paddingBottom: 24 }}
          renderItem={({ item: p }) => (
            <TouchableOpacity style={styles.row} onPress={() => openProfile(p)} activeOpacity={0.85}>
              <Avatar url={p.avatar_url} initial={p.avatar_initial || p.name?.[0]} size={48} fontSize={18} style={{ marginRight: 12 }} />
              <View style={{ flex: 1 }}>
                <View style={styles.nameRow}>
                  <Text style={styles.name} numberOfLines={1}>{p.name || 'GoHustlr user'}</Text>
                  {p.verified && <Ionicons name="checkmark-circle" size={14} color={colors.primary} style={{ marginLeft: 4 }} />}
                </View>
                {p.username ? <Text style={styles.username} numberOfLines={1}>@{p.username}</Text> : null}
                <View style={styles.metaRow}>
                  {p.review_count > 0
                    ? <>
                        <RatingStars rating={Number(p.rating) || 0} size={11} />
                        <Text style={styles.metaText}>  {Number(p.rating).toFixed(1)} ({p.review_count})</Text>
                      </>
                    : <Text style={styles.metaText}>No reviews yet</Text>}
                  {p.city ? <Text style={styles.metaText}> · {p.city}</Text> : null}
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: 14,
    marginHorizontal: 16, marginTop: 12, paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  searchInput: { flex: 1, fontSize: 15, color: colors.textPrimary, padding: 0 },
  empty: { alignItems: 'center', paddingHorizontal: 32, paddingTop: 56 },
  emptyIconWrap: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center', marginBottom: 14,
  },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: colors.textPrimary, marginBottom: 8 },
  emptyText: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 22 },
  row: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    marginHorizontal: 16, marginTop: 8, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  name: { fontSize: 15, fontWeight: '700', color: colors.textPrimary, flexShrink: 1 },
  username: { fontSize: 12, color: colors.primary, marginTop: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  metaText: { fontSize: 12, color: colors.textMuted },
});
