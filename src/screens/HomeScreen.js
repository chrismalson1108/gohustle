import React, { useState, useMemo, useEffect } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  ScrollView, TextInput, StyleSheet, RefreshControl, Platform,
} from 'react-native';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import GradientHeader from '../components/GradientHeader';
import JobCard from '../components/JobCard';
import JobsMap from '../components/JobsMap';
import XPBar from '../components/XPBar';
import FilterSheet, { DEFAULT_FILTERS, countActiveFilters } from '../components/FilterSheet';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { useHaptic } from '../hooks/useHaptic';
import { haversineMiles, milesLabel } from '../lib/geo';
import { colors, gradients } from '../theme';
import { CATEGORIES } from '../data/mockData';

// Extract state abbreviation from location string like "Austin, TX"
function getState(location) {
  if (!location) return null;
  if (location.toLowerCase().includes('remote')) return 'remote';
  const parts = location.split(',');
  const last = parts[parts.length - 1]?.trim();
  return last?.length === 2 ? last : null;
}

// Extract day abbreviation from slot label like "Mon Dec 16, 2:00 PM"
function getSlotDays(slots) {
  const days = new Set();
  (slots || []).forEach(s => {
    if (!s.taken && s.label) {
      const prefix = s.label.split(' ')[0];
      if (['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].includes(prefix)) {
        days.add(prefix);
      }
    }
  });
  return days;
}

function matchesPay(job, payRange) {
  if (payRange === 'any') return true;
  const effective = job.payType === 'hourly'
    ? job.pay * (job.estimatedHours || 1)
    : job.pay;
  if (payRange === 'under25')  return effective < 25;
  if (payRange === '25-50')    return effective >= 25  && effective < 50;
  if (payRange === '50-100')   return effective >= 50  && effective < 100;
  if (payRange === '100+')     return effective >= 100;
  return true;
}

export default function HomeScreen({ navigation }) {
  const { name, streakDays, levelInfo, xp, school } = useUser();
  const { jobs, bookings, refreshJobs, refreshBookings, blockedIds } = useJobs();
  const haptic = useHaptic();
  const [selectedCat, setSelectedCat] = useState('all');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [showFilter, setShowFilter] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [userCoords, setUserCoords] = useState(null);
  const [viewMode, setViewMode] = useState('list'); // 'list' | 'map'

  // Best-effort device location for distance + "Nearest" sort (no prompt spam)
  useEffect(() => {
    if (Platform.OS === 'web') return;
    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        let granted = status === 'granted';
        if (!granted) {
          const req = await Location.requestForegroundPermissionsAsync();
          granted = req.status === 'granted';
        }
        if (!granted) return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setUserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      } catch (_) {}
    })();
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshJobs(), refreshBookings()]);
    setRefreshing(false);
  };

  // Build state list from available jobs for the location filter
  const availableStates = useMemo(() => {
    const states = new Set();
    jobs.forEach(j => {
      const st = getState(j.location);
      if (st && st !== 'remote') states.add(st);
    });
    return Array.from(states).sort();
  }, [jobs]);

  const filtered = useMemo(() => {
    let list = jobs.filter(j => {
      // Only show open listings in Browse
      if (j.status !== 'open') return false;

      // Hide gigs from users you've blocked
      if (blockedIds?.has(j.posterId)) return false;

      // Category chip
      if (selectedCat !== 'all' && j.category !== selectedCat) return false;

      // Search text
      const q = search.toLowerCase();
      if (q && !j.title.toLowerCase().includes(q) && !j.description.toLowerCase().includes(q)) return false;

      // Pay range
      if (!matchesPay(j, filters.payRange)) return false;

      // Pay type
      if (filters.payType !== 'any' && j.payType !== filters.payType) return false;

      // Urgent only
      if (filters.urgentOnly && !j.urgent) return false;

      // Verified students only
      if (filters.verifiedStudentsOnly && !j.poster?.studentVerified) return false;

      // My campus only
      if (filters.campusOnly && (!school || (j.poster?.school || '').trim().toLowerCase() !== school.trim().toLowerCase())) return false;

      // Location
      if (filters.location !== 'any') {
        if (filters.location === 'remote') {
          if (!j.location?.toLowerCase().includes('remote')) return false;
        } else {
          if (getState(j.location) !== filters.location) return false;
        }
      }

      // Days availability
      if (filters.days.length > 0) {
        const slotDays = getSlotDays(j.slots);
        const hasMatch = filters.days.some(d => slotDays.has(d));
        if (!hasMatch) return false;
      }

      return true;
    });

    // Attach distance when we know the user's location
    if (userCoords) {
      list = list.map(j => ({ ...j, _distanceMi: haversineMiles(userCoords, { lat: j.lat, lng: j.lng }) }));
    }

    // Sort
    if (filters.sortBy === 'pay_high') {
      list = [...list].sort((a, b) => {
        const pa = a.payType === 'hourly' ? a.pay * (a.estimatedHours || 1) : a.pay;
        const pb = b.payType === 'hourly' ? b.pay * (b.estimatedHours || 1) : b.pay;
        return pb - pa;
      });
    } else if (filters.sortBy === 'pay_low') {
      list = [...list].sort((a, b) => {
        const pa = a.payType === 'hourly' ? a.pay * (a.estimatedHours || 1) : a.pay;
        const pb = b.payType === 'hourly' ? b.pay * (b.estimatedHours || 1) : b.pay;
        return pa - pb;
      });
    } else if (filters.sortBy === 'nearest') {
      list = [...list].sort((a, b) => {
        const da = a._distanceMi ?? Infinity;
        const db = b._distanceMi ?? Infinity;
        return da - db;
      });
    } else {
      // 'newest' — bumped gigs float to the top (a bump refreshes bumped_at), so
      // sort by recency rather than relying on the DB's created_at fetch order.
      const freshness = (j) => new Date(j.bumpedAt || j.createdAt || 0).getTime();
      list = [...list].sort((a, b) => freshness(b) - freshness(a));
    }

    return list;
  }, [jobs, selectedCat, search, filters, blockedIds, userCoords, school]);

  const activeFilterCount = countActiveFilters(filters);

  const header = (
    <>
      <GradientHeader colors={gradients.primary}>
        <View style={styles.topRow}>
          <View>
            <Text style={styles.greeting}>Hey {name}</Text>
            <Text style={styles.sub}>Ready to hustle?</Text>
          </View>
          <View style={styles.streakBox}>
            <Ionicons name="flame" size={20} color="#F59E0B" />
            <View style={{ height: 2 }} />
            <Text style={styles.streakNum}>{streakDays}</Text>
            <Text style={styles.streakLabel}>day streak</Text>
          </View>
        </View>
        <View style={styles.xpWrap}>
          <XPBar levelInfo={levelInfo} xp={xp} dark />
        </View>
        <View style={styles.searchRow}>
          <View style={styles.searchBox}>
            <Ionicons name="search" size={16} color={colors.textMuted} style={styles.searchIcon} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search gigs..."
              placeholderTextColor={colors.textMuted}
              value={search}
              onChangeText={setSearch}
            />
            {search.length > 0 && (
              <TouchableOpacity onPress={() => setSearch('')}>
                <Ionicons name="close-circle" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity
            style={[styles.filterBtn, activeFilterCount > 0 && styles.filterBtnActive]}
            onPress={() => { haptic.light(); setShowFilter(true); }}
          >
            <Ionicons name="options" size={20} color={activeFilterCount > 0 ? '#fff' : colors.primary} />
            {activeFilterCount > 0 && (
              <View style={styles.filterBadge}>
                <Text style={styles.filterBadgeText}>{activeFilterCount}</Text>
              </View>
            )}
          </TouchableOpacity>
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
              <Ionicons name={cat.ion} size={14} color={active ? '#fff' : colors.primary} style={styles.catIcon} />
              <Text style={[styles.catLabel, active && styles.catLabelActive]}>
                {cat.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <View style={styles.resultsRow}>
        <Text style={styles.sectionTitle}>
          {filtered.length} gig{filtered.length !== 1 ? 's' : ''} available
        </Text>
        <View style={styles.resultsRight}>
          {activeFilterCount > 0 && (
            <TouchableOpacity onPress={() => setFilters(DEFAULT_FILTERS)}>
              <Text style={styles.clearFilters}>Clear filters</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.viewToggle}
            onPress={() => { haptic.light(); setViewMode(m => (m === 'list' ? 'map' : 'list')); }}
          >
            <Ionicons name={viewMode === 'list' ? 'map-outline' : 'list-outline'} size={16} color={colors.primary} />
            <Text style={styles.viewToggleText}>{viewMode === 'list' ? 'Map' : 'List'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </>
  );

  if (viewMode === 'map') {
    return (
      <View style={styles.container}>
        {header}
        <JobsMap
          jobs={filtered}
          userCoords={userCoords}
          onPressJob={(j) => navigation.navigate('JobDetail', { jobId: j.id })}
        />
        <FilterSheet
          visible={showFilter}
          filters={filters}
          availableStates={availableStates}
          mySchool={school}
          onApply={(f) => { setFilters(f); setShowFilter(false); }}
          onClose={() => setShowFilter(false)}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={filtered}
        keyExtractor={j => j.id}
        ListHeaderComponent={header}
        renderItem={({ item }) => (
          <JobCard
            job={item}
            distanceLabel={milesLabel(item._distanceMi)}
            onPress={() => navigation.navigate('JobDetail', { jobId: item.id })}
            bookingStatus={bookings.find(b => b.jobId === item.id)?.status}
          />
        )}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="search" size={44} color={colors.textMuted} style={styles.emptyIcon} />
            <Text style={styles.emptyText}>No gigs match your filters</Text>
            {activeFilterCount > 0 && (
              <TouchableOpacity onPress={() => setFilters(DEFAULT_FILTERS)} style={styles.emptyReset}>
                <Text style={styles.emptyResetText}>Reset all filters</Text>
              </TouchableOpacity>
            )}
          </View>
        }
      />

      <FilterSheet
        visible={showFilter}
        filters={filters}
        availableStates={availableStates}
        onApply={(f) => { setFilters(f); setShowFilter(false); }}
        onClose={() => setShowFilter(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 },
  greeting: { fontSize: 24, fontWeight: '800', color: '#fff', marginBottom: 2 },
  sub: { fontSize: 13, color: 'rgba(255,255,255,0.7)' },
  streakBox: {
    alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 14, paddingHorizontal: 14, paddingVertical: 8,
  },
  streakFire: { fontSize: 22 },
  streakNum: { fontSize: 22, fontWeight: '900', color: '#fff', lineHeight: 26 },
  streakLabel: { fontSize: 10, color: 'rgba(255,255,255,0.75)', fontWeight: '600' },
  xpWrap: { marginBottom: 16 },
  searchRow: { flexDirection: 'row', alignItems: 'center' },
  searchBox: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 14,
    paddingHorizontal: 14, height: 46,
  },
  searchIcon: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, fontSize: 15, color: colors.textPrimary },
  searchClear: { fontSize: 14, color: colors.textMuted, paddingHorizontal: 4 },
  filterBtn: {
    width: 46, height: 46, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 10,
  },
  filterBtnActive: { backgroundColor: '#fff' },
  filterIcon: { fontSize: 20 },
  filterBadge: {
    position: 'absolute', top: -4, right: -4,
    backgroundColor: colors.urgent, borderRadius: 8,
    minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 3,
  },
  filterBadgeText: { color: '#fff', fontSize: 10, fontWeight: '900' },
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
  resultsRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 13, fontWeight: '700', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  clearFilters: { fontSize: 13, fontWeight: '700', color: colors.primary },
  resultsRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  viewToggle: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  viewToggleText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  list: { paddingBottom: 24 },
  empty: { alignItems: 'center', paddingTop: 48, paddingHorizontal: 32 },
  emptyIcon: { fontSize: 40, marginBottom: 10 },
  emptyText: { fontSize: 16, color: colors.textSecondary, textAlign: 'center' },
  emptyReset: { marginTop: 16, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.primaryLight },
  emptyResetText: { fontSize: 14, fontWeight: '700', color: colors.primary },
});
