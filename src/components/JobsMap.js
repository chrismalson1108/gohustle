import React from 'react';
import { View, Text, Platform, StyleSheet } from 'react-native';
import MapView, { Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import { CATEGORY_COLORS } from '../data/mockData';
import { colors } from '../theme';

// Map of nearby gigs. Centers on the user (or the first gig) and drops a pin per
// gig that has coordinates. Tapping a pin opens that gig.
export default function JobsMap({ jobs, userCoords, onPressJob }) {
  if (Platform.OS === 'web') {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>Map view isn't available on web.</Text>
      </View>
    );
  }

  const pins = (jobs || []).filter(j => j.lat != null && j.lng != null);
  const center = userCoords || (pins[0] ? { lat: pins[0].lat, lng: pins[0].lng } : { lat: 39.5, lng: -98.35 });

  return (
    <View style={styles.wrap}>
      <MapView
        provider={PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        showsUserLocation={!!userCoords}
        initialRegion={{
          latitude: center.lat,
          longitude: center.lng,
          latitudeDelta: userCoords ? 0.25 : 8,
          longitudeDelta: userCoords ? 0.25 : 8,
        }}
      >
        {pins.map(j => (
          <Marker
            key={j.id}
            coordinate={{ latitude: j.lat, longitude: j.lng }}
            title={j.title}
            description={j.payType === 'hourly' ? `$${j.pay}/hr · ${j.location}` : `$${j.pay} · ${j.location}`}
            pinColor={CATEGORY_COLORS[j.category] || colors.primary}
            onCalloutPress={() => onPressJob?.(j)}
          />
        ))}
      </MapView>
      {pins.length === 0 && (
        <View style={styles.noPins} pointerEvents="none">
          <Text style={styles.noPinsText}>No gigs with a location to map yet.</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  fallbackText: { fontSize: 14, color: colors.textMuted },
  noPins: { position: 'absolute', top: 12, left: 16, right: 16, alignItems: 'center' },
  noPinsText: { backgroundColor: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 12, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, overflow: 'hidden' },
});
