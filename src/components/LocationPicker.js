import React, { useState, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  ScrollView, StyleSheet, ActivityIndicator,
} from 'react-native';
import * as Location from 'expo-location';
import { colors, shadows } from '../theme';

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
        if (countrycode === 'US' && state) return `${name}, ${US_STATE_ABBR[state] || state}`;
        if (state) return `${name}, ${state}`;
        return `${name}, ${country}`;
      })
      .filter((v, i, a) => a.indexOf(v) === i); // dedupe
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
    onChange(text);
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

  const select = (loc) => {
    setQuery(loc);
    onChange(loc);
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
        select(label);
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
        <Text style={styles.pin}>📍</Text>
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
              <Text style={styles.gpsIcon}>🎯</Text>
            </TouchableOpacity>
          )
        }
        {query.length > 0 && !locating && (
          <TouchableOpacity
            onPress={() => { setQuery(''); onChange(''); setResults([]); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.clear}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {locError ? <Text style={styles.errorText}>{locError}</Text> : null}

      {showDropdown && (
        <View style={styles.dropdown}>
          <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 240 }}>
            {remoteFiltered.map(loc => (
              <TouchableOpacity key={loc} style={styles.suggestion} onPress={() => select(loc)}>
                <Text style={styles.suggestIcon}>🌐</Text>
                <Text style={styles.suggestText}>{loc}</Text>
              </TouchableOpacity>
            ))}
            {searching && (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.loadingText}>Searching cities…</Text>
              </View>
            )}
            {results.map(loc => (
              <TouchableOpacity key={loc} style={styles.suggestion} onPress={() => select(loc)}>
                <Text style={styles.suggestIcon}>📍</Text>
                <Text style={styles.suggestText}>{loc}</Text>
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
    backgroundColor: colors.surface, borderRadius: 14,
    borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 14, height: 50,
  },
  pin:    { fontSize: 16, marginRight: 8 },
  input:  { flex: 1, fontSize: 15, color: colors.textPrimary },
  gpsBtn: { marginLeft: 6 },
  gpsIcon: { fontSize: 16 },
  clear:  { fontSize: 16, color: colors.textMuted, marginLeft: 6 },
  errorText: { fontSize: 12, color: colors.urgent, marginTop: 4, marginLeft: 4 },
  dropdown: {
    position: 'absolute', top: 54, left: 0, right: 0,
    backgroundColor: colors.surface,
    borderRadius: 14, borderWidth: 1.5, borderColor: colors.border,
    zIndex: 200, ...shadows.md,
  },
  suggestion: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 13,
    borderBottomWidth: 1, borderBottomColor: colors.divider,
  },
  suggestIcon: { fontSize: 14, marginRight: 10 },
  suggestText: { fontSize: 14, color: colors.textPrimary, fontWeight: '500' },
  loadingRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
  },
  loadingText: { fontSize: 13, color: colors.textMuted, marginLeft: 8 },
});
