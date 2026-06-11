import React, { useState, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  ScrollView, TextInput, StyleSheet,
} from 'react-native';
import GradientHeader from '../components/GradientHeader';
import JobCard from '../components/JobCard';
import XPBar from '../components/XPBar';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { useHaptic } from '../hooks/useHaptic';
import { colors, gradients } from '../theme';
import { CATEGORIES } from '../data/mockData';

export default function HomeScreen({ navigation }) {
  const { name, streakDays, levelInfo, xp } = useUser();
  const { jobs } = useJobs();
  const haptic = useHaptic();
  const [selectedCat, setSelectedCat] = useState('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => jobs.filter(j => {
    const catMatch = selectedCat === 'all' || j.category === selectedCat;
    const q = search.toLowerCase();
    const searchMatch = !q || j.title.toLowerCase().includes(q) || j.description.toLowerCase().includes(q);
    return catMatch && searchMatch;
  }), [jobs, selectedCat, search]);

  const header = (
    <>
      <GradientHeader colors={gradients.primary}>
        <View style={styles.topRow}>
          <View>
            <Text style={styles.greeting}>Hey {name} 👋</Text>
            <Text style={styles.sub}>Ready to hustle?</Text>
          </View>
          <View style={styles.streakBox}>
            <Text style={styles.streakFire}>🔥</Text>
            <Text style={styles.streakNum}>{streakDays}</Text>
            <Text style={styles.streakLabel}>day streak</Text>
          </View>
        </View>
        <View style={styles.xpWrap}>
          <XPBar levelInfo={levelInfo} xp={xp} dark />
        </View>
        <View style={styles.searchBox}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="Search gigs..."
            placeholderTextColor={colors.textMuted}
            value={search}
            onChangeText={setSearch}
          />
        </View>
      </GradientHeader>

      <ScrollView
        horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.catRow}
      >
        {CATEGORIES.map(cat => {
          const active = selectedCat === cat.id;
          return (
            <TouchableOpacity
              key={cat.id}
              style={[styles.catChip, active && styles.catChipActive]}
              onPress={() => { haptic.light(); setSelectedCat(cat.id); }}
            >
              <Text style={styles.catIcon}>{cat.icon}</Text>
              <Text style={[styles.catLabel, active && styles.catLabelActive]}>
                {cat.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <Text style={styles.sectionTitle}>
        {filtered.length} gig{filtered.length !== 1 ? 's' : ''} available
      </Text>
    </>
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={filtered}
        keyExtractor={j => j.id}
        ListHeaderComponent={header}
        renderItem={({ item }) => (
          <JobCard
            job={item}
            onPress={() => navigation.navigate('JobDetail', { jobId: item.id })}
          />
        )}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>🔎</Text>
            <Text style={styles.emptyText}>No gigs match your search</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 },
  greeting: { fontSize: 24, fontWeight: '800', color: '#fff', marginBottom: 2 },
  sub: { fontSize: 13, color: 'rgba(255,255,255,0.7)' },
  streakBox: { alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 8 },
  streakFire: { fontSize: 22 },
  streakNum: { fontSize: 22, fontWeight: '900', color: '#fff', lineHeight: 26 },
  streakLabel: { fontSize: 10, color: 'rgba(255,255,255,0.75)', fontWeight: '600' },
  xpWrap: { marginBottom: 16 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 14,
    paddingHorizontal: 14, height: 46,
  },
  searchIcon: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, fontSize: 15, color: colors.textPrimary },
  catRow: { paddingHorizontal: 16, paddingVertical: 14 },
  catChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: 22, backgroundColor: colors.surface,
    borderWidth: 1.5, borderColor: colors.border,
    marginRight: 10,
  },
  catChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  catIcon: { fontSize: 15, marginRight: 6 },
  catLabel: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  catLabelActive: { color: '#fff' },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: colors.textMuted, paddingHorizontal: 20, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  list: { paddingBottom: 24 },
  empty: { alignItems: 'center', paddingTop: 48 },
  emptyIcon: { fontSize: 40, marginBottom: 10 },
  emptyText: { fontSize: 16, color: colors.textSecondary },
});
