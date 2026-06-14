import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useHaptic } from '../hooks/useHaptic';
import { isFavorite, addFavorite, removeFavorite } from '../lib/favorites';
import GradientHeader from '../components/GradientHeader';
import Avatar from '../components/Avatar';
import RatingStars from '../components/RatingStars';
import { colors, gradients, shadows } from '../theme';
import { CATEGORY_COLORS } from '../data/mockData';

const avg = (arr) => arr.length ? (arr.reduce((s, r) => s + Number(r.rating || 0), 0) / arr.length) : null;

export default function PublicProfileScreen({ route, navigation }) {
  const { userId } = route.params;
  const { user } = useAuth();
  const haptic = useHaptic();
  const isSelf = user?.id === userId;
  const [profile, setProfile] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fav, setFav] = useState(false);

  const toggleFav = async () => {
    if (!user || isSelf) return;
    haptic.light();
    try {
      if (fav) { await removeFavorite(user.id, userId); setFav(false); }
      else { await addFavorite(user.id, userId); setFav(true); }
    } catch (_) {}
  };

  const load = useCallback(async () => {
    if (user && !isSelf) isFavorite(user.id, userId).then(setFav).catch(() => {});
    const [{ data: prof }, { data: revs }, { data: jobs }] = await Promise.all([
      supabase.from('profiles')
        .select('id, name, avatar_initial, avatar_url, city, bio, skills, rating, review_count, member_since, verified, created_at')
        .eq('id', userId).single(),
      supabase.from('reviews')
        .select('id, rating, text, date, role, job:jobs(title), reviewer:profiles!reviewer_id(id, name, avatar_initial, avatar_url)')
        .eq('reviewed_user_id', userId).order('created_at', { ascending: false }),
      supabase.from('jobs')
        .select('id, title, category, pay, pay_type, location, status')
        .eq('poster_id', userId).eq('status', 'open').order('created_at', { ascending: false }),
    ]);
    setProfile(prof || null);
    setReviews(revs || []);
    setListings(jobs || []);
    setLoading(false);
  }, [userId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>;
  }
  if (!profile) {
    return <View style={styles.center}><Text style={styles.muted}>This profile is unavailable.</Text></View>;
  }

  const workerReviews = reviews.filter(r => r.role === 'earner');
  const clientReviews = reviews.filter(r => r.role === 'poster');
  const overall = avg(reviews);
  const workerAvg = avg(workerReviews);
  const clientAvg = avg(clientReviews);
  const completed = workerReviews.map(r => r.job?.title).filter(Boolean);

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
      <GradientHeader colors={gradients.profile}>
        <View style={styles.headerRow}>
          <Avatar url={profile.avatar_url} initial={profile.avatar_initial || profile.name?.[0]} size={64} fontSize={26}
            bg="rgba(255,255,255,0.25)" borderColor="rgba(255,255,255,0.6)" borderWidth={3} style={{ marginRight: 16 }} />
          <View style={{ flex: 1 }}>
            <View style={styles.nameRow}>
              <Text style={styles.name}>{profile.name || 'GoHustlr user'}</Text>
              {profile.verified && <Ionicons name="checkmark-circle" size={16} color="#fff" style={{ marginLeft: 6 }} />}
            </View>
            {overall != null
              ? <RatingStars rating={overall} size={14} />
              : <Text style={styles.subWhite}>No reviews yet</Text>}
            <Text style={styles.subWhite}>
              {reviews.length > 0 ? `${overall.toFixed(1)} · ${reviews.length} review${reviews.length !== 1 ? 's' : ''}` : ''}
              {profile.member_since ? `${reviews.length ? ' · ' : ''}Since ${profile.member_since}` : ''}
            </Text>
            {profile.city ? <Text style={styles.subWhite}>{profile.city}</Text> : null}
          </View>
          {!isSelf && user && (
            <TouchableOpacity onPress={toggleFav} style={styles.favBtn} activeOpacity={0.8}>
              <Ionicons name={fav ? 'heart' : 'heart-outline'} size={22} color={fav ? '#FB7185' : '#fff'} />
            </TouchableOpacity>
          )}
        </View>
      </GradientHeader>

      {/* Rating breakdown */}
      <View style={styles.breakRow}>
        <View style={styles.breakItem}>
          <Ionicons name="briefcase" size={16} color={colors.primary} />
          <Text style={styles.breakVal}>{workerAvg != null ? workerAvg.toFixed(1) : '—'}</Text>
          <Text style={styles.breakLabel}>As a worker ({workerReviews.length})</Text>
        </View>
        <View style={styles.breakDivider} />
        <View style={styles.breakItem}>
          <Ionicons name="megaphone" size={16} color={colors.primary} />
          <Text style={styles.breakVal}>{clientAvg != null ? clientAvg.toFixed(1) : '—'}</Text>
          <Text style={styles.breakLabel}>As a client ({clientReviews.length})</Text>
        </View>
      </View>

      {profile.bio ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>
          <Text style={styles.bio}>{profile.bio}</Text>
        </View>
      ) : null}

      {profile.skills?.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Skills</Text>
          <View style={styles.chipWrap}>
            {profile.skills.map(s => (
              <View key={s} style={styles.skillChip}><Text style={styles.skillText}>{s}</Text></View>
            ))}
          </View>
        </View>
      )}

      {listings.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Open gigs they posted ({listings.length})</Text>
          {listings.map(j => {
            const cc = CATEGORY_COLORS[j.category] || colors.primary;
            return (
              <TouchableOpacity key={j.id} style={styles.jobRow} onPress={() => navigation.navigate('JobDetail', { jobId: j.id })}>
                <View style={[styles.jobAccent, { backgroundColor: cc }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.jobTitle} numberOfLines={1}>{j.title}</Text>
                  <Text style={styles.jobMeta}>{j.pay_type === 'hourly' ? `$${j.pay}/hr` : `$${j.pay} flat`} · {j.location}</Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {completed.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent work ({completed.length})</Text>
          {completed.slice(0, 8).map((t, i) => (
            <View key={i} style={styles.workRow}>
              <Ionicons name="checkmark-done-circle" size={15} color={colors.success} style={{ marginRight: 8 }} />
              <Text style={styles.workText} numberOfLines={1}>{t}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Reviews ({reviews.length})</Text>
        {reviews.length === 0 ? (
          <Text style={styles.muted}>No reviews yet.</Text>
        ) : reviews.map(r => (
          <View key={r.id} style={styles.reviewCard}>
            <View style={styles.reviewHead}>
              <Avatar url={r.reviewer?.avatar_url} initial={r.reviewer?.avatar_initial || r.reviewer?.name?.[0]} size={32} fontSize={13} style={{ marginRight: 10 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.reviewer}>{r.reviewer?.name || 'User'}</Text>
                <View style={styles.reviewMetaRow}>
                  <RatingStars rating={r.rating} size={11} />
                  <View style={[styles.roleTag, r.role === 'poster' && styles.roleTagClient]}>
                    <Text style={[styles.roleTagText, r.role === 'poster' && styles.roleTagTextClient]}>
                      {r.role === 'poster' ? 'as a client' : 'as a worker'}
                    </Text>
                  </View>
                </View>
              </View>
              {r.date ? <Text style={styles.reviewDate}>{r.date}</Text> : null}
            </View>
            {r.text ? <Text style={styles.reviewText}>{r.text}</Text> : null}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, padding: 24 },
  muted: { fontSize: 14, color: colors.textMuted },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  favBtn: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center', marginLeft: 8,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  name: { fontSize: 22, fontWeight: '900', color: '#fff' },
  subWhite: { fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 3 },
  breakRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    marginHorizontal: 16, marginTop: 16, borderRadius: 16, paddingVertical: 16,
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  breakItem: { flex: 1, alignItems: 'center' },
  breakVal: { fontSize: 20, fontWeight: '900', color: colors.textPrimary, marginTop: 4 },
  breakLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '600', marginTop: 2 },
  breakDivider: { width: 1, height: 44, backgroundColor: colors.border },
  section: { paddingHorizontal: 16, marginTop: 24 },
  sectionTitle: { fontSize: 13, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 12 },
  bio: { fontSize: 14, color: colors.textSecondary, lineHeight: 21 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap' },
  skillChip: { backgroundColor: colors.primaryLight, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8, marginBottom: 8 },
  skillText: { fontSize: 12, fontWeight: '700', color: colors.primary },
  jobRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: 14, padding: 12, marginBottom: 8, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border, ...shadows.sm,
  },
  jobAccent: { width: 4, height: 36, borderRadius: 2, marginRight: 12 },
  jobTitle: { fontSize: 14, fontWeight: '800', color: colors.textPrimary },
  jobMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  workRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7 },
  workText: { fontSize: 13, color: colors.textSecondary, flex: 1 },
  reviewCard: { backgroundColor: colors.surface, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: colors.border, ...shadows.sm },
  reviewHead: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  reviewer: { fontSize: 13, fontWeight: '800', color: colors.textPrimary, marginBottom: 3 },
  reviewMetaRow: { flexDirection: 'row', alignItems: 'center' },
  roleTag: { backgroundColor: colors.primaryLight, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 8 },
  roleTagClient: { backgroundColor: '#FEF3C7' },
  roleTagText: { fontSize: 10, fontWeight: '700', color: colors.primary },
  roleTagTextClient: { color: '#B45309' },
  reviewDate: { fontSize: 11, color: colors.textMuted },
  reviewText: { fontSize: 13, color: colors.textSecondary, lineHeight: 20 },
});
