import React, { useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, ScrollView,
  StyleSheet, Switch,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { colors, gradients, shadows } from '../theme';
import { useHaptic } from '../hooks/useHaptic';

export const DEFAULT_FILTERS = {
  payRange:   'any',   // 'any' | 'under25' | '25-50' | '50-100' | '100+'
  days:       [],      // [] = any; ['Mon','Fri'] = those days
  location:   'any',   // 'any' | 'remote' | state abbreviation like 'TX'
  payType:    'any',   // 'any' | 'flat' | 'hourly'
  urgentOnly: false,
  verifiedStudentsOnly: false, // only gigs from Verified Student posters
  sortBy:     'newest', // 'newest' | 'pay_high' | 'pay_low'
};

export function countActiveFilters(f) {
  let n = 0;
  if (f.payRange   !== 'any')   n++;
  if (f.days.length > 0)        n++;
  if (f.location   !== 'any')   n++;
  if (f.payType    !== 'any')   n++;
  if (f.urgentOnly)             n++;
  if (f.verifiedStudentsOnly)   n++;
  if (f.sortBy     !== 'newest') n++;
  return n;
}

const DAY_OPTIONS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const PAY_OPTIONS = [
  { id: 'any',      label: 'Any Pay' },
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

export default function FilterSheet({ visible, filters, availableStates, onApply, onClose }) {
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
            <Text style={styles.title}>Filter Gigs</Text>
            <TouchableOpacity onPress={reset}>
              <Text style={styles.resetText}>Reset All</Text>
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>

            {/* Sort */}
            <Section title="Sort By">
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
            <Section title="Pay Range">
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
            <Section title="Pay Type">
              <View style={styles.chipRow}>
                {[
                  { id: 'any',     label: 'Any' },
                  { id: 'flat',    ion: 'cash',  label: 'Flat Rate' },
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
            <Section title="Available Days">
              <Text style={styles.sectionHint}>Tap days you're free — shows gigs with matching slots</Text>
              <View style={styles.dayRow}>
                {DAY_OPTIONS.map(d => (
                  <TouchableOpacity
                    key={d}
                    style={[styles.dayBtn, local.days.includes(d) && styles.dayBtnActive]}
                    onPress={() => toggleDay(d)}
                  >
                    <Text style={[styles.dayText, local.days.includes(d) && styles.dayTextActive]}>{d}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Section>

            {/* Location */}
            <Section title="Location">
              <View style={styles.chipRow}>
                <Chip
                  label="Any Location"
                  ion="location"
                  active={local.location === 'any'}
                  onPress={() => { haptic.selection(); set('location', 'any'); }}
                />
                <Chip
                  label="Remote Only"
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
                <View>
                  <View style={styles.toggleLabelRow}>
                    <Ionicons name="flash" size={14} color={colors.textPrimary} style={{ marginRight: 5 }} />
                    <Text style={styles.toggleLabel}>Urgent gigs only</Text>
                  </View>
                  <Text style={styles.toggleSub}>Needed ASAP — higher chance of quick earnings</Text>
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
                <View>
                  <View style={styles.toggleLabelRow}>
                    <Ionicons name="school" size={14} color={colors.textPrimary} style={{ marginRight: 5 }} />
                    <Text style={styles.toggleLabel}>Verified students only</Text>
                  </View>
                  <Text style={styles.toggleSub}>Only show gigs from posters with a Verified Student badge</Text>
                </View>
                <Switch
                  value={local.verifiedStudentsOnly}
                  onValueChange={v => { haptic.selection(); set('verifiedStudentsOnly', v); }}
                  trackColor={{ false: colors.border, true: colors.primary }}
                  thumbColor="#fff"
                />
              </View>
            </Section>

          </ScrollView>

          {/* Apply button */}
          <View style={styles.footer}>
            <TouchableOpacity onPress={apply} activeOpacity={0.85} style={{ flex: 1 }}>
              <LinearGradient colors={gradients.primary} style={styles.applyBtn}>
                <Text style={styles.applyText}>
                  Show Results{activeCount > 0 ? ` · ${activeCount} filter${activeCount !== 1 ? 's' : ''} active` : ''}
                </Text>
              </LinearGradient>
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
          style={{ marginRight: 5 }}
        />
      )}
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: '#fff', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    maxHeight: '90%', ...shadows.md,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border,
    alignSelf: 'center', marginTop: 12, marginBottom: 6,
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  title: { fontSize: 18, fontWeight: '900', color: colors.textPrimary },
  resetText: { fontSize: 14, fontWeight: '700', color: colors.urgent },
  body: { paddingHorizontal: 20, paddingBottom: 16 },
  section: { marginTop: 22 },
  sectionTitle: {
    fontSize: 12, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10,
  },
  sectionHint: { fontSize: 12, color: colors.textMuted, marginBottom: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, margin: 4,
    backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border,
    flexDirection: 'row', alignItems: 'center',
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  chipTextActive: { color: '#fff' },
  dayRow: { flexDirection: 'row', justifyContent: 'space-between' },
  dayBtn: {
    flex: 1, marginHorizontal: 3, paddingVertical: 11, borderRadius: 12,
    backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border,
    alignItems: 'center',
  },
  dayBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  dayText: { fontSize: 12, fontWeight: '800', color: colors.textSecondary },
  dayTextActive: { color: '#fff' },
  toggleRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: 16,
    padding: 14, borderWidth: 1, borderColor: colors.border,
  },
  toggleLabelRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
  toggleLabel: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  toggleSub: { fontSize: 12, color: colors.textMuted, maxWidth: 240 },
  footer: {
    flexDirection: 'row', padding: 16, paddingBottom: 32,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  applyBtn: { borderRadius: 16, paddingVertical: 16, alignItems: 'center' },
  applyText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
