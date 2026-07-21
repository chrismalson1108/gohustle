import React, { useState, useMemo, useEffect } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  ScrollView, TextInput, StyleSheet, RefreshControl, Platform,
} from 'react-native';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import JobCard from '../components/JobCard';
import JobsMap from '../components/JobsMap';
import FilterSheet, { DEFAULT_FILTERS, countActiveFilters } from '../components/FilterSheet';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { useHaptic } from '../hooks/useHaptic';
import { haversineMiles, milesLabel } from '../lib/geo';
import { useTabBarScrollHandler, expandTabBar } from '../lib/tabBarScroll';
import { colors } from '../theme';
import { CATEGORIES } from '../data/mockData';
import { matchesForYou } from '../lib/filters';

// "For You" is a pseudo-category that matches gigs to the viewer's profile skills.
const CHIPS = [{ id: 'foryou', label: 'For You', ion: 'sparkles' }, ...CATEGORIES];

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

// Geocode a place string → {lat,lng} via the free Photon geocoder (same source as
// LocationPicker). Used to place the radius-filter center and any gigs that were
// posted without stored coords.
async function geocodeOne(q) {
  try {
    const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1&layer=city&layer=locality&lang=en`);
    const json = await res.json();
    const c = json.features?.[0]?.geometry?.coordinates;
    return Array.isArray(c) ? { lat: c[1], lng: c[0] } : null;
  } catch {
    return null;
  }
}

export default function HomeScreen({ navigation }) {
  const { name, streakDays, school, skills, city } = useUser();
  const { jobs, bookings, refreshJobs, refreshBookings, blockedIds } = useJobs();
  const haptic = useHaptic();
  const insets = useSafeAreaInsets();
  const onTabBarScroll = useTabBarScrollHandler();
  const [selectedCat, setSelectedCat] = useState('all');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [showFilter, setShowFilter] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [userCoords, setUserCoords] = useState(null);
  const [profileCoords, setProfileCoords] = useState(null);
  const [geoCache, setGeoCache] = useState({});
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

  // Geocode the profile city → default center for the radius filter.
  useEffect(() => {
    if (!city) return;
    let cancelled = false;
    geocodeOne(city).then(c => { if (!cancelled && c) setProfileCoords(c); });
    return () => { cancelled = true; };
  }, [city]);

  // Back-fill coords for gigs posted without stored lat/lng by geocoding their
  // location string (cached) so the radius filter can place them.
  useEffect(() => {
    const needed = [...new Set(
      jobs.filter(j => (j.lat == null || j.lng == null) && j.location && !j.location.toLowerCase().includes('remote'))
        .map(j => j.location),
    )].filter(loc => !(loc in geoCache));
    if (needed.length === 0) return;
    let cancelled = false;
    needed.forEach(loc => geocodeOne(loc).then(c => { if (!cancelled && c) setGeoCache(p => ({ ...p, [loc]: c })); }));
    return () => { cancelled = true; };
  }, [jobs, geoCache]);

  // Radius-filter center: explicitly chosen location wins, else the geocoded
  // profile city, else the device location.
  const center = (filters.near && filters.near.lat != null)
    ? { lat: filters.near.lat, lng: filters.near.lng }
    : (profileCoords || userCoords);

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

      // Category chip ("For You" matches against the viewer's profile skills)
      if (selectedCat === 'foryou') {
        if (!matchesForYou(j, skills)) return false;
      } else if (selectedCat !== 'all' && j.category !== selectedCat) return false;

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

      // Distance radius — remote gigs always show; in-person gigs need coords
      // (stored or geocoded) within the radius of the center.
      if (filters.radius !== 'any' && center && center.lat != null && !(j.location || '').toLowerCase().includes('remote')) {
        const coords = (j.lat != null && j.lng != null) ? { lat: j.lat, lng: j.lng } : geoCache[j.location];
        if (!coords) return false;
        if (haversineMiles(center, coords) > filters.radius) return false;
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
  }, [jobs, selectedCat, search, filters, blockedIds, userCoords, center, geoCache, school, skills]);

  const activeFilterCount = countActiveFilters(filters);
  const forYouNoSkills = selectedCat === 'foryou' && (skills?.length || 0) === 0;

  const header = (
    <>
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <View style={styles.topRow}>
          <View>
            <Text style={styles.greeting}>Hey {name}</Text>
            <Text style={styles.sub}>Ready to hustle?</Text>
          </View>
          <View style={styles.streakPill}>
            <Ionicons name="flame" size={14} color="#F59E0B" />
            {streakDays > 0 ? (
              <>
                <Text style={styles.streakNum}>{streakDays}</Text>
                <Text style={styles.streakLabel}>week streak</Text>
              </>
            ) : (
              <Text style={styles.streakLabel}>Start a streak</Text>
            )}
          </View>
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
            <Ionicons name="options" size={20} color="#fff" />
            {activeFilterCount > 0 && (
              <View style={styles.filterBadge}>
                <Text style={styles.filterBadgeText}>{activeFilterCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        horizontal showsHorizontalScrollIndicator={false}
        style={styles.catScroll}
        contentContainerStyle={styles.catRow}
      >
        {CHIPS.map(cat => {
          const active = selectedCat === cat.id;
          return (
            <TouchableOpacity
              key={cat.id}
              style={[styles.catChip, active && styles.catChipActive]}
              onPress={() => { haptic.light(); setSelectedCat(cat.id); }}
            >
              <Ionicons name={cat.ion} size={14} color={active ? '#fff' : colors.textSecondary} style={styles.catIcon} />
              <Text style={[styles.catLabel, active && styles.catLabelActive]}>
                {cat.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <View style={styles.resultsRow}>
        <Text style={styles.sectionTitle} numberOfLines={1}>
          {filtered.length} gig{filtered.length !== 1 ? 's' : ''} available
        </Text>
        <View style={styles.resultsRight}>
          {activeFilterCount > 0 && (
            <TouchableOpacity onPress={() => setFilters(DEFAULT_FILTERS)}>
              <Text style={styles.clearFilters} numberOfLines={1}>Clear filters</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.viewToggle}
            onPress={() => { haptic.light(); navigation.navigate('MarketInsights'); }}
          >
            <Ionicons name="bar-chart-outline" size={16} color={colors.textPrimary} />
            <Text style={styles.viewToggleText} numberOfLines={1}>Insights</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.viewToggle}
            onPress={() => { haptic.light(); expandTabBar(); setViewMode(m => (m === 'list' ? 'map' : 'list')); }}
          >
            <Ionicons name={viewMode === 'list' ? 'map-outline' : 'list-outline'} size={16} color={colors.textPrimary} />
            <Text style={styles.viewToggleText} numberOfLines={1}>{viewMode === 'list' ? 'Map' : 'List'}</Text>
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
          defaultCenterLabel={city}
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
        onScroll={onTabBarScroll}
        scrollEventThrottle={32}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name={forYouNoSkills ? 'sparkles-outline' : 'search'} size={44} color={colors.textMuted} style={styles.emptyIcon} />
            <Text style={styles.emptyText}>
              {forYouNoSkills
                ? 'Add skills to your profile to get gigs matched to you'
                : selectedCat === 'foryou'
                  ? 'No gigs match your skills right now'
                  : 'No gigs match your filters'}
            </Text>
            {forYouNoSkills ? (
              <TouchableOpacity onPress={() => navigation.navigate('ProfileTab', { screen: 'Settings', initial: false })} style={styles.emptyReset}>
                <Text style={styles.emptyResetText}>Add your skills</Text>
              </TouchableOpacity>
            ) : activeFilterCount > 0 ? (
              <TouchableOpacity onPress={() => setFilters(DEFAULT_FILTERS)} style={styles.emptyReset}>
                <Text style={styles.emptyResetText}>Reset all filters</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        }
      />

      <FilterSheet
        visible={showFilter}
        filters={filters}
        availableStates={availableStates}
        mySchool={school}
        defaultCenterLabel={city}
        onApply={(f) => { setFilters(f); setShowFilter(false); }}
        onClose={() => setShowFilter(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    backgroundColor: colors.background,
    paddingHorizontal: 20, paddingBottom: 4,
  },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  greeting: { fontSize: 26, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.5, marginBottom: 2 },
  sub: { fontSize: 14, color: colors.textSecondary },
  streakPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: colors.surface,
    borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7,
  },
  streakNum: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  streakLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: '500' },
  searchRow: { flexDirection: 'row', alignItems: 'center' },
  searchBox: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: 14,
    paddingHorizontal: 14, height: 48,
  },
  searchIcon: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, fontSize: 15, color: colors.textPrimary },
  filterBtn: {
    width: 48, height: 48, borderRadius: 14,
    backgroundColor: colors.textPrimary,
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 10,
  },
  filterBtnActive: { backgroundColor: colors.primary },
  filterBadge: {
    position: 'absolute', top: -4, right: -4,
    backgroundColor: colors.urgent, borderRadius: 8,
    minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 3,
  },
  filterBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  catScroll: { flexGrow: 0, flexShrink: 0 },
  catRow: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, alignItems: 'center' },
  catChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: 999, backgroundColor: colors.surface,
    marginRight: 8,
  },
  catChipActive: { backgroundColor: colors.textPrimary },
  catIcon: { fontSize: 15, marginRight: 6 },
  catLabel: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  catLabelActive: { color: '#fff' },
  resultsRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, marginBottom: 8, marginTop: 4,
  },
  sectionTitle: {
    fontSize: 13, fontWeight: '600', color: colors.textMuted,
    // Yield space (and ellipsize) so the right-hand action cluster is never
    // clipped when a filter is active (Clear filters + Insights + Map/List).
    flexShrink: 1, marginRight: 8,
  },
  clearFilters: { fontSize: 13, fontWeight: '600', color: colors.primary },
  resultsRight: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 0 },
  viewToggle: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  viewToggleText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  // Clearance for the floating tab bar (which overlays content instead of
  // reserving layout space like the old opaque bar did).
  list: { paddingBottom: 148 },
  empty: { alignItems: 'center', paddingTop: 48, paddingHorizontal: 32 },
  emptyIcon: { fontSize: 40, marginBottom: 10 },
  emptyText: { fontSize: 16, color: colors.textSecondary, textAlign: 'center' },
  emptyReset: { marginTop: 16, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.primaryLight },
  emptyResetText: { fontSize: 14, fontWeight: '700', color: colors.primary },
});
