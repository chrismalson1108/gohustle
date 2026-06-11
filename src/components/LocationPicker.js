import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  ScrollView, StyleSheet,
} from 'react-native';
import { colors, shadows } from '../theme';

const LOCATIONS = [
  'Remote', 'Zoom / Remote', 'Work from Home',
  'Austin, TX', 'Cedar Park, TX', 'Round Rock, TX', 'Pflugerville, TX',
  'Dallas, TX', 'Fort Worth, TX', 'Arlington, TX', 'Plano, TX', 'Frisco, TX',
  'Houston, TX', 'San Antonio, TX', 'El Paso, TX', 'Lubbock, TX', 'Amarillo, TX',
  'Corpus Christi, TX', 'Waco, TX', 'Killeen, TX', 'McKinney, TX', 'Garland, TX',
  'New York, NY', 'Los Angeles, CA', 'Chicago, IL', 'Phoenix, AZ', 'Philadelphia, PA',
  'San Diego, CA', 'San Jose, CA', 'Jacksonville, FL', 'Indianapolis, IN',
  'San Francisco, CA', 'Columbus, OH', 'Charlotte, NC', 'Seattle, WA',
  'Denver, CO', 'Boston, MA', 'Nashville, TN', 'Baltimore, MD', 'Louisville, KY',
  'Portland, OR', 'Las Vegas, NV', 'Memphis, TN', 'Atlanta, GA', 'Miami, FL',
  'Minneapolis, MN', 'Tampa, FL', 'New Orleans, LA', 'Oakland, CA', 'Raleigh, NC',
  'Colorado Springs, CO', 'Virginia Beach, VA', 'Sacramento, CA', 'Tucson, AZ',
  'Kansas City, MO', 'Albuquerque, NM', 'Omaha, NE', 'Cleveland, OH', 'Tulsa, OK',
  'St. Louis, MO', 'Cincinnati, OH', 'Pittsburgh, PA', 'Orlando, FL', 'Bakersfield, CA',
];

export default function LocationPicker({ value, onChange, placeholder }) {
  const [query, setQuery] = useState(value || '');
  const [open, setOpen] = useState(false);

  const suggestions = query.length > 1
    ? LOCATIONS.filter(l => l.toLowerCase().includes(query.toLowerCase())).slice(0, 6)
    : [];

  const select = (loc) => {
    setQuery(loc);
    onChange(loc);
    setOpen(false);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.inputRow}>
        <Text style={styles.pin}>📍</Text>
        <TextInput
          style={styles.input}
          value={query}
          placeholder={placeholder || 'City, State or "Remote"'}
          placeholderTextColor={colors.textMuted}
          onChangeText={t => { setQuery(t); onChange(t); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => { setQuery(''); onChange(''); }}>
            <Text style={styles.clear}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {open && suggestions.length > 0 && (
        <View style={styles.dropdown}>
          <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 200 }}>
            {suggestions.map(loc => (
              <TouchableOpacity key={loc} style={styles.suggestion} onPress={() => select(loc)}>
                <Text style={styles.suggestIcon}>
                  {loc.startsWith('Remote') || loc.startsWith('Zoom') || loc.startsWith('Work') ? '🌐' : '📍'}
                </Text>
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
  pin: { fontSize: 16, marginRight: 8 },
  input: { flex: 1, fontSize: 15, color: colors.textPrimary },
  clear: { fontSize: 16, color: colors.textMuted, padding: 4 },
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
});
