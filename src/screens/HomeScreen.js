import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  View, Text, FlatList, TouchableOpacity,
  ScrollView, TextInput, StyleSheet, RefreshControl, Platform,
} from 'react-native';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import JobCard from '../components/JobCard';
import JobsMap from '../components/JobsMap';
import CategoryPicker from '../components/CategoryPicker';
import FilterSheet, { DEFAULT_FILTERS, countActiveFilters } from '../components/FilterSheet';
import { useUser } from '../context/UserContext';
import { useJobs } from '../context/JobsContext';
import { useHaptic } from '../hooks/useHaptic';
import { milesLabel } from '../lib/geo';
import { useTabBarScrollHandler, expandTabBar } from '../lib/tabBarScroll';
import { colors } from '../theme';
import { applyJobFilters, availableStatesFrom } from '../lib/filters';
import { fetchCategories } from '../lib/categories';
import { browseChipsFromJobs } from '../../shared/categories.js';
import { maskLocation } from '../lib/address';

// "For You" and "All" are pseudo-categories, not entries in the taxonomy — their ids
// are in RESERVED_CATEGORY_SLUGS precisely so a real category can never collide with
// the value this screen holds in `selectedCat`.
const PSEUDO_CHIPS = [
  { id: 'foryou', label: 'For You', ion: 'sparkles' },
  { id: 'all',    label: 'All',     ion: 'grid' },
];
const isPseudoCat = (id) => PSEUDO_CHIPS.some(c => c.id === id);

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
  const { name, streakDays, school, skills, city, recentCategorySlugs } = useUser();
  const { jobs, bookings, refreshJobs, refreshBookings, blockedIds } = useJobs();
  const haptic = useHaptic();
  const insets = useSafeAreaInsets();
  const onTabBarScroll = useTabBarScrollHandler();
  // A category SLUG, or one of the pseudo-category ids above.
  const [selectedCat, setSelectedCat] = useState('all');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [showFilter, setShowFilter] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [userCoords, setUserCoords] = useState(null);
  const [profileCoords, setProfileCoords] = useState(null);
  const [geoCache, setGeoCache] = useState({});
  // Locations we've already fired a geocode for this session. Kept in a ref (not
  // state) so recording an attempt never re-renders / re-runs the back-fill effect.
  const geoAttempted = useRef(new Set());
  // Unmount-only guard for the back-fill. A per-effect `cancelled` flag would
  // also trip on every jobs change (refresh/realtime), throwing away an in-flight
  // geocode whose location the ref above has already marked attempted — so that
  // location would stay uncoordinated for the rest of the session.
  const geoMounted = useRef(true);
  useEffect(() => () => { geoMounted.current = false; }, []);
  const [viewMode, setViewMode] = useState('list'); // 'list' | 'map'
  // Community categories, so a chip for one someone created shows the creator's own
  // label and icon rather than a title-cased slug. fetchCategories never rejects and
  // falls back to the seed catalog, so the chips render either way.
  const [catIndex, setCatIndex] = useState(null);

  useEffect(() => {
    let active = true;
    fetchCategories().then(idx => { if (active) setCatIndex(idx); });
    return () => { active = false; };
  }, []);

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
  // Each location is requested at most once per session: the effect no longer
  // depends on geoCache (which it also sets), so a resolved request can't re-run
  // it and re-fire the still-unresolved locations — that fanned out ~quadratically
  // to the public geocoder. The ref guards the in-flight ones the cache can't see.
  useEffect(() => {
    const needed = [...new Set(
      jobs.filter(j => (j.lat == null || j.lng == null) && j.location && !j.location.toLowerCase().includes('remote'))
        .map(j => j.location),
    )].filter(loc => !geoAttempted.current.has(loc));
    if (needed.length === 0) return;
    needed.forEach(loc => {
      geoAttempted.current.add(loc);
      // Privacy: a raw location label can be an exact street address. Send only
      // the city-level masked form to the third-party geocoder — that's all the
      // radius filter needs anyway. Cache stays keyed by the raw label.
      const masked = maskLocation(loc);
      // Nothing city-level survived the mask — geocoding the placeholder would
      // return an unrelated place, so leave it uncoordinated (radius filter hides it).
      if (masked === 'Nearby area') return;
      geocodeOne(masked).then(c => { if (geoMounted.current && c) setGeoCache(p => ({ ...p, [loc]: c })); });
    });
  }, [jobs]);

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
  const availableStates = useMemo(() => availableStatesFrom(jobs), [jobs]);

  // Hand the filter the coords we back-filled above: applyJobFilters places a gig
  // from job.lat/lng alone, so without this merge the radius filter would drop every
  // gig posted before coords were stored. Same shape as the web browse page.
  const jobsGeo = useMemo(
    () => jobs.map(j => ((j.lat != null && j.lng != null) || !geoCache[j.location])
      ? j
      : { ...j, lat: geoCache[j.location].lat, lng: geoCache[j.location].lng }),
    [jobs, geoCache],
  );

  // The browse chips are derived from what the feed actually carries, not from a
  // module-level constant computed at import time off a fixed seven-label array —
  // that was why a category a user created was only reachable under "All".
  const chips = useMemo(
    () => [
      ...PSEUDO_CHIPS,
      ...browseChipsFromJobs(jobs, {
        recentSlugs: recentCategorySlugs,
        extra: catIndex ? catIndex.list : [],
      }),
    ],
    [jobs, recentCategorySlugs, catIndex],
  );

  // Shared with the web feed so the two can't drift — the rule this screen used to
  // keep inline compared `j.category` to the chip label with `===`, which no custom
  // category could ever satisfy. The merge aliases go with it so a gig posted under a
  // spelling that curation has since folded away still answers to its new chip.
  const catAliases = catIndex ? catIndex.aliases : undefined;
  const filtered = useMemo(
    () => applyJobFilters(jobsGeo, {
      selectedCat, search, filters, blockedIds, userCoords, center,
      mySchool: school, forYouSkills: skills, myBookings: bookings,
      extraAliases: catAliases,
    }),
    // `bookings` is a real dependency: the feed hides gigs this viewer already won,
    // so the list must recompute when a booking's status changes.
    [jobsGeo, bookings, selectedCat, search, filters, blockedIds, userCoords, center, school, skills, catAliases],
  );

  const activeFilterCount = countActiveFilters(filters);
  const forYouNoSkills = selectedCat === 'foryou' && (skills?.length || 0) === 0;

  const header = (
    <>
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <View style={styles.topRow}>
          <View style={styles.greetingWrap}>
            <Text style={styles.greeting} numberOfLines={1}>Hey {name}</Text>
            <Text style={styles.sub} numberOfLines={1}>Ready to hustle?</Text>
          </View>
          <View style={styles.streakPill}>
            <Ionicons name="flame" size={14} color={colors.accentDeep} />
            {streakDays > 0 ? (
              <>
                <Text style={styles.streakNum} numberOfLines={1}>{streakDays}</Text>
                <Text style={styles.streakLabel} numberOfLines={1}>week streak</Text>
              </>
            ) : (
              <Text style={styles.streakLabel} numberOfLines={1}>Start a streak</Text>
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
        {chips.map(cat => {
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
        {/* The chips only surface categories the feed is carrying right now, so this
            is how the rest of the catalog — and a category with no live gigs — stays
            reachable. Browsing must never mint a category, hence allowCreate={false}. */}
        <View style={styles.moreCat}>
          <CategoryPicker
            value={isPseudoCat(selectedCat) ? '' : selectedCat}
            onChange={(label, slug) => setSelectedCat(slug || 'all')}
            recentSlugs={recentCategorySlugs}
            allowCreate={false}
            placeholder="More"
          />
        </View>
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
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
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
  // A long profile name must ellipsize rather than push the streak pill off
  // the screen — RN defaults flexShrink to 0, so the wrapper needs it explicitly.
  greetingWrap: { flex: 1, minWidth: 0, marginRight: 12 },
  greeting: { fontSize: 26, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.5, marginBottom: 2 },
  sub: { fontSize: 14, color: colors.textSecondary },
  streakPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0,
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
  // Narrow enough to read as one more item in the chip row rather than a form field.
  moreCat: { width: 128 },
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
