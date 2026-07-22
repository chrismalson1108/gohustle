import React, { useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, ScrollView,
  StyleSheet, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import LocationPicker from './LocationPicker';
import { colors, radii, shadows } from '../theme';
import { useHaptic } from '../hooks/useHaptic';

export const DEFAULT_FILTERS = {
  payRange:   'any',   // 'any' | 'under25' | '25-50' | '50-100' | '100+'
  days:       [],      // [] = any; ['Mon','Fri'] = those days
  location:   'any',   // 'any' | 'remote' | state abbreviation like 'TX'
  payType:    'any',   // 'any' | 'flat' | 'hourly'
  urgentOnly: false,
  verifiedStudentsOnly: false, // only gigs from Verified Student posters
  campusOnly: false,           // only gigs from posters at the viewer's school
  radius:     'any',   // 'any' | 5 | 10 | 25 | 50 — miles from the center
  near:       null,    // { label, lat, lng } center; null = profile/device location
  sortBy:     'newest', // 'newest' | 'pay_high' | 'pay_low'
};

const RADIUS_OPTIONS = [
  { id: 'any', label: 'Any distance' },
  { id: 5,     label: 'Within 5 mi' },
  { id: 10,    label: 'Within 10 mi' },
  { id: 25,    label: 'Within 25 mi' },
  { id: 50,    label: 'Within 50 mi' },
];

export function countActiveFilters(f) {
  let n = 0;
  if (f.payRange   !== 'any')   n++;
  if (f.days.length > 0)        n++;
  if (f.location   !== 'any')   n++;
  if (f.payType    !== 'any')   n++;
  if (f.urgentOnly)             n++;
  if (f.verifiedStudentsOnly)   n++;
  if (f.campusOnly)             n++;
  if (f.radius     !== 'any')   n++;
  if (f.sortBy     !== 'newest') n++;
  return n;
}

const DAY_OPTIONS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const PAY_OPTIONS = [
  { id: 'any',      label: 'Any pay' },
  { id: 'under25',  label: 'Under $25' },
  { id: '25-50',    label: '$25 – $50' },
  { id: '50-100',   label: '$50 – $100' },
  { id: '100+',     label: '$100+' },
];

const SORT_OPTIONS = [
  { id: 'newest',   ion: 'time',          label: 'Newest' },
  { id: 'nearest',  ion: 'navigate',      label: 'Nearest' },
  { id: 'pay_high', ion: 'cash',          label: 'Pay: High → Low' },
  { id: 'pay_low',  ion: 'trending-down', label: 'Pay: Low → High' },
];

export default function FilterSheet({ visible, filters, availableStates, mySchool, defaultCenterLabel, onApply, onClose }) {
  const haptic = useHaptic();
  const [local, setLocal] = useState(filters);

  const set = (k, v) => setLocal(p => ({ ...p, [k]: v }));

  const toggleDay = (day) => {
    haptic.selection();
    set('days', local.days.includes(day)
      ? local.days.filter(d => d !== day)
      : [...local.days, day]);
  };

  const reset = () => {
    haptic.light();
    setLocal({ ...DEFAULT_FILTERS });
  };

  const apply = () => {
    haptic.medium();
    onApply(local);
  };

  const activeCount = countActiveFilters(local);

  // sync local state when sheet opens
  React.useEffect(() => {
    if (visible) setLocal(filters);
  }, [visible]);

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          {/* Handle */}
          <View style={styles.handle} />

          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>Filter gigs</Text>
            <TouchableOpacity onPress={reset} style={styles.resetBtn}>
              <Text style={styles.resetText} numberOfLines={1}>Reset all</Text>
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>

            {/* Sort */}
            <Section title="Sort by">
              <View style={styles.chipRow}>
                {SORT_OPTIONS.map(o => (
                  <Chip
                    key={o.id}
                    label={o.label}
                    ion={o.ion}
                    active={local.sortBy === o.id}
                    onPress={() => { haptic.selection(); set('sortBy', o.id); }}
                  />
                ))}
              </View>
            </Section>

            {/* Pay Range */}
            <Section title="Pay range">
              <View style={styles.chipRow}>
                {PAY_OPTIONS.map(o => (
                  <Chip
                    key={o.id}
                    label={o.label}
                    active={local.payRange === o.id}
                    onPress={() => { haptic.selection(); set('payRange', o.id); }}
                  />
                ))}
              </View>
            </Section>

            {/* Pay Type */}
            <Section title="Pay type">
              <View style={styles.chipRow}>
                {[
                  { id: 'any',     label: 'Any' },
                  { id: 'flat',    ion: 'cash',  label: 'Flat rate' },
                  { id: 'hourly',  ion: 'time',  label: 'Hourly' },
                ].map(o => (
                  <Chip
                    key={o.id}
                    label={o.label}
                    ion={o.ion}
                    active={local.payType === o.id}
                    onPress={() => { haptic.selection(); set('payType', o.id); }}
                  />
                ))}
              </View>
            </Section>

            {/* Availability */}
            <Section title="Available days">
              <Text style={styles.sectionHint}>Tap days you're free — shows gigs with matching slots</Text>
              <View style={styles.dayRow}>
                {DAY_OPTIONS.map(d => (
                  <TouchableOpacity
                    key={d}
                    style={[styles.dayBtn, local.days.includes(d) && styles.dayBtnActive]}
                    onPress={() => toggleDay(d)}
                  >
                    <Text style={[styles.dayText, local.days.includes(d) && styles.dayTextActive]} numberOfLines={1}>{d}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Section>

            {/* Distance (radius from a location) */}
            <Section title="Distance">
              <View style={styles.chipRow}>
                {RADIUS_OPTIONS.map(o => (
                  <Chip
                    key={String(o.id)}
                    label={o.label}
                    active={local.radius === o.id}
                    onPress={() => { haptic.selection(); set('radius', o.id); }}
                  />
                ))}
              </View>
              {local.radius !== 'any' && (
                <>
                  <Text style={[styles.sectionHint, { marginTop: 12, marginBottom: 6 }]}>Center of search</Text>
                  <LocationPicker
                    value={local.near?.label ?? defaultCenterLabel ?? ''}
                    onChange={(label, coords) =>
                      set('near', label ? { label, lat: coords?.lat ?? null, lng: coords?.lng ?? null } : null)
                    }
                    placeholder="Your location"
                  />
                  <Text style={[styles.sectionHint, { marginTop: 8 }]}>
                    Gigs within {local.radius} mi of this location. Remote gigs always show.
                  </Text>
                </>
              )}
            </Section>

            {/* Location */}
            <Section title="Location">
              <View style={styles.chipRow}>
                <Chip
                  label="Any location"
                  ion="location"
                  active={local.location === 'any'}
                  onPress={() => { haptic.selection(); set('location', 'any'); }}
                />
                <Chip
                  label="Remote only"
                  ion="laptop"
                  active={local.location === 'remote'}
                  onPress={() => { haptic.selection(); set('location', 'remote'); }}
                />
              </View>
              {availableStates.length > 0 && (
                <>
                  <Text style={[styles.sectionHint, { marginTop: 10 }]}>Filter by state:</Text>
                  <View style={styles.chipRow}>
                    {availableStates.map(st => (
                      <Chip
                        key={st}
                        label={st}
                        active={local.location === st}
                        onPress={() => { haptic.selection(); set('location', st); }}
                      />
                    ))}
                  </View>
                </>
              )}
            </Section>

            {/* Urgent only */}
            <Section title="Urgency">
              <View style={styles.toggleRow}>
                <View style={styles.toggleTextWrap}>
                  <View style={styles.toggleLabelRow}>
                    <Ionicons name="flash" size={14} color={colors.textSecondary} style={{ marginRight: 6 }} />
                    <Text style={styles.toggleLabel} numberOfLines={1}>Urgent gigs only</Text>
                  </View>
                  <Text style={styles.toggleSub} numberOfLines={2}>Needed ASAP — higher chance of quick earnings</Text>
                </View>
                <Switch
                  value={local.urgentOnly}
                  onValueChange={v => { haptic.selection(); set('urgentOnly', v); }}
                  trackColor={{ false: colors.border, true: colors.primary }}
                  thumbColor="#fff"
                />
              </View>
            </Section>

            {/* Trust */}
            <Section title="Trust">
              <View style={styles.toggleRow}>
                <View style={styles.toggleTextWrap}>
                  <View style={styles.toggleLabelRow}>
                    <Ionicons name="school" size={14} color={colors.textSecondary} style={{ marginRight: 6 }} />
                    <Text style={styles.toggleLabel} numberOfLines={1}>Verified students only</Text>
                  </View>
                  <Text style={styles.toggleSub} numberOfLines={2}>Only show gigs from posters with a Verified Student badge</Text>
                </View>
                <Switch
                  value={local.verifiedStudentsOnly}
                  onValueChange={v => { haptic.selection(); set('verifiedStudentsOnly', v); }}
                  trackColor={{ false: colors.border, true: colors.primary }}
                  thumbColor="#fff"
                />
              </View>
              {!!mySchool && (
                <View style={[styles.toggleRow, { marginTop: 12 }]}>
                  <View style={styles.toggleTextWrap}>
                    <View style={styles.toggleLabelRow}>
                      <Ionicons name="business" size={14} color={colors.textSecondary} style={{ marginRight: 6 }} />
                      <Text style={styles.toggleLabel} numberOfLines={1}>My campus only</Text>
                    </View>
                    <Text style={styles.toggleSub} numberOfLines={2}>Only gigs from posters at {mySchool}</Text>
                  </View>
                  <Switch
                    value={local.campusOnly}
                    onValueChange={v => { haptic.selection(); set('campusOnly', v); }}
                    trackColor={{ false: colors.border, true: colors.primary }}
                    thumbColor="#fff"
                  />
                </View>
              )}
            </Section>

          </ScrollView>

          {/* Apply button */}
          <View style={styles.footer}>
            <TouchableOpacity onPress={apply} activeOpacity={0.85} style={styles.applyBtn}>
              <Text style={styles.applyText} numberOfLines={1}>
                Show results{activeCount > 0 ? ` · ${activeCount} filter${activeCount !== 1 ? 's' : ''} active` : ''}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Chip({ label, ion, active, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
    >
      {ion && (
        <Ionicons
          name={ion}
          size={14}
          color={active ? '#fff' : colors.textSecondary}
          style={{ marginRight: 6 }}
        />
      )}
      <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    maxHeight: '90%', ...shadows.md,
  },
  handle: {
    width: 40, height: 4, borderRadius: radii.pill, backgroundColor: colors.border,
    alignSelf: 'center', marginTop: 12, marginBottom: 8,
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 12,
  },
  title: { fontSize: 24, fontWeight: '700', color: colors.textPrimary, letterSpacing: -0.4, flexShrink: 1, marginRight: 12 },
  resetBtn: { flexShrink: 0, paddingVertical: 10, paddingLeft: 8 },
  resetText: { fontSize: 14, fontWeight: '600', color: colors.primary },
  body: { paddingHorizontal: 20, paddingBottom: 20 },
  section: { marginTop: 24 },
  sectionTitle: {
    fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 12,
  },
  sectionHint: { fontSize: 12, color: colors.textMuted, marginBottom: 8, lineHeight: 17 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: radii.pill,
    marginRight: 8, marginBottom: 8, alignSelf: 'flex-start',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    flexDirection: 'row', alignItems: 'center',
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, flexShrink: 1 },
  chipTextActive: { color: '#fff' },
  // Wraps instead of forcing 7 equal columns — at 320pt each column would leave
  // ~27pt for the label and clip it.
  dayRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  dayBtn: {
    minWidth: 44, flexGrow: 1, paddingVertical: 11, paddingHorizontal: 8, borderRadius: radii.md,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  dayBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  dayText: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  dayTextActive: { color: '#fff' },
  toggleRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: colors.background, borderRadius: radii.lg,
    padding: 16,
  },
  toggleTextWrap: { flex: 1, minWidth: 0, marginRight: 12 },
  toggleLabelRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  toggleLabel: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
  toggleSub: { fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  footer: {
    flexDirection: 'row', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32,
  },
  applyBtn: {
    flex: 1, backgroundColor: colors.primary, borderRadius: radii.md,
    paddingVertical: 16, paddingHorizontal: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  applyText: { color: '#fff', fontSize: 16, fontWeight: '600', flexShrink: 1 },
});
