import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  ScrollView, StyleSheet, ActivityIndicator,
} from 'react-native';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { colors, radii, shadows } from '../theme';

const REMOTE_OPTIONS = ['Remote', 'Zoom / Remote', 'Work from Home'];

async function searchCities(query) {
  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=7&layer=city&layer=locality&lang=en`;
    const res  = await fetch(url);
    const json = await res.json();
    return (json.features || [])
      .filter(f => f.properties?.name && (f.properties?.state || f.properties?.country))
      .map(f => {
        const { name, state, country, countrycode } = f.properties;
        const coords = f.geometry?.coordinates; // [lng, lat]
        let label;
        if (countrycode === 'US' && state) label = `${name}, ${US_STATE_ABBR[state] || state}`;
        else if (state) label = `${name}, ${state}`;
        else label = `${name}, ${country}`;
        return { label, lat: coords?.[1] ?? null, lng: coords?.[0] ?? null };
      })
      .filter((v, i, a) => a.findIndex(x => x.label === v.label) === i); // dedupe by label
  } catch {
    return [];
  }
}

const US_STATE_ABBR = {
  Alabama:'AL', Alaska:'AK', Arizona:'AZ', Arkansas:'AR', California:'CA',
  Colorado:'CO', Connecticut:'CT', Delaware:'DE', Florida:'FL', Georgia:'GA',
  Hawaii:'HI', Idaho:'ID', Illinois:'IL', Indiana:'IN', Iowa:'IA',
  Kansas:'KS', Kentucky:'KY', Louisiana:'LA', Maine:'ME', Maryland:'MD',
  Massachusetts:'MA', Michigan:'MI', Minnesota:'MN', Mississippi:'MS', Missouri:'MO',
  Montana:'MT', Nebraska:'NE', Nevada:'NV', 'New Hampshire':'NH', 'New Jersey':'NJ',
  'New Mexico':'NM', 'New York':'NY', 'North Carolina':'NC', 'North Dakota':'ND',
  Ohio:'OH', Oklahoma:'OK', Oregon:'OR', Pennsylvania:'PA', 'Rhode Island':'RI',
  'South Carolina':'SC', 'South Dakota':'SD', Tennessee:'TN', Texas:'TX', Utah:'UT',
  Vermont:'VT', Virginia:'VA', Washington:'WA', 'West Virginia':'WV',
  Wisconsin:'WI', Wyoming:'WY', 'District of Columbia':'DC',
};

export default function LocationPicker({ value, onChange, placeholder }) {
  const [query, setQuery]       = useState(value || '');
  const [open, setOpen]         = useState(false);
  const [results, setResults]   = useState([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState('');
  const debounceRef = useRef(null);

  const handleChange = (text) => {
    setQuery(text);
    onChange(text, null);
    setOpen(true);
    setResults([]);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.length < 2) return;

    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      const cities = await searchCities(text);
      setResults(cities);
      setSearching(false);
    }, 350);
  };

  const select = (item) => {
    const label = typeof item === 'string' ? item : item.label;
    const coords = (item && typeof item === 'object' && item.lat != null)
      ? { lat: item.lat, lng: item.lng } : null;
    setQuery(label);
    onChange(label, coords);
    setOpen(false);
    setResults([]);
  };

  const useDeviceLocation = async () => {
    setLocating(true);
    setLocError('');
    setOpen(false);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setLocError('Location permission denied. Please type your city.');
        setLocating(false);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const [place] = await Location.reverseGeocodeAsync({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      });
      if (place) {
        const city      = place.city || place.subregion || place.district || '';
        const stateAbbr = place.regionCode || place.region || '';
        const label     = city && stateAbbr ? `${city}, ${stateAbbr}` : city || stateAbbr || 'Unknown location';
        select({ label, lat: pos.coords.latitude, lng: pos.coords.longitude });
      } else {
        setLocError('Could not determine location. Please type your city.');
      }
    } catch {
      setLocError('Location unavailable. Please type your city.');
    }
    setLocating(false);
  };

  const remoteFiltered = query.length > 0
    ? REMOTE_OPTIONS.filter(r => r.toLowerCase().includes(query.toLowerCase()))
    : REMOTE_OPTIONS;

  const showDropdown = open && (results.length > 0 || remoteFiltered.length > 0 || searching);

  return (
    <View style={styles.wrap}>
      <View style={styles.inputRow}>
        <Ionicons name="location-outline" size={16} color={colors.textMuted} style={styles.pin} />
        <TextInput
          style={styles.input}
          value={query}
          placeholder={placeholder || 'City, State or "Remote"'}
          placeholderTextColor={colors.textMuted}
          onChangeText={handleChange}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 180)}
          autoCorrect={false}
          autoCapitalize="words"
        />
        {locating
          ? <ActivityIndicator size="small" color={colors.primary} style={{ marginLeft: 6 }} />
          : (
            <TouchableOpacity onPress={useDeviceLocation} style={styles.gpsBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="locate" size={16} color={colors.primary} />
            </TouchableOpacity>
          )
        }
        {query.length > 0 && !locating && (
          <TouchableOpacity
            onPress={() => { setQuery(''); onChange('', null); setResults([]); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.clearBtn}
          >
            <Ionicons name="close-circle" size={17} color={colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {locError ? <Text style={styles.errorText}>{locError}</Text> : null}

      {showDropdown && (
        <View style={styles.dropdown}>
          <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 240 }}>
            {remoteFiltered.map(loc => (
              <TouchableOpacity key={loc} style={styles.suggestion} onPress={() => select(loc)}>
                <Ionicons name="globe-outline" size={15} color={colors.textMuted} style={styles.suggestIcon} />
                <Text style={styles.suggestText} numberOfLines={1}>{loc}</Text>
              </TouchableOpacity>
            ))}
            {searching && (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.loadingText} numberOfLines={1}>Searching cities…</Text>
              </View>
            )}
            {results.map(loc => (
              <TouchableOpacity key={loc.label} style={styles.suggestion} onPress={() => select(loc)}>
                <Ionicons name="location-outline" size={15} color={colors.textMuted} style={styles.suggestIcon} />
                <Text style={styles.suggestText} numberOfLines={1}>{loc.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', zIndex: 100 },
  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, minHeight: 50,
  },
  pin:      { marginRight: 8 },
  input:    { flex: 1, fontSize: 15, color: colors.textPrimary, paddingVertical: 12 },
  gpsBtn:   { marginLeft: 8, flexShrink: 0 },
  clearBtn: { marginLeft: 8, flexShrink: 0 },
  errorText: { fontSize: 12, color: colors.urgent, marginTop: 6, marginLeft: 4, lineHeight: 16 },
  dropdown: {
    position: 'absolute', top: '100%', marginTop: 6, left: 0, right: 0,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    zIndex: 200, ...shadows.md,
  },
  // No row dividers: the last row's border would draw a hard line across the
  // panel's rounded bottom edge, and overflow:'hidden' would kill the Android
  // elevation. Breathing room separates the rows instead.
  suggestion: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
  },
  suggestIcon: { marginRight: 10, flexShrink: 0 },
  suggestText: { fontSize: 14, color: colors.textPrimary, fontWeight: '500', flexShrink: 1, lineHeight: 19 },
  loadingRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
  },
  loadingText: { fontSize: 13, color: colors.textMuted, marginLeft: 8, flexShrink: 1, lineHeight: 17 },
});
