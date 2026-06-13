import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, KeyboardAvoidingView, Platform, Keyboard,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import LocationPicker from '../components/LocationPicker';
import DateTimePicker from '../components/DateTimePicker';
import { colors, gradients } from '../theme';
import { Ionicons } from '@expo/vector-icons';
import { CATEGORIES } from '../data/mockData';

const CATS = CATEGORIES.filter(c => c.id !== 'all');
const INITIAL = {
  title: '', category: '', customCategory: '', pay: '', payType: 'flat',
  location: '', description: '', requirements: '', urgent: false, slots: [],
};

export default function PostJobScreen({ navigation }) {
  const { addJob } = useJobs();
  const { showToast } = useUser();
  const haptic = useHaptic();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState(INITIAL);
  const [showCustomCat, setShowCustomCat] = useState(false);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const effectiveCategory = form.category === 'other' ? form.customCategory : form.category;

  const handlePost = () => {
    Keyboard.dismiss();
    if (!form.title || !effectiveCategory || !form.pay || !form.location || !form.description) {
      haptic.error();
      return;
    }
    haptic.success();
    const slots = form.slots.length > 0
      ? form.slots
      : [{ id: 's1', label: 'Flexible — Contact to Schedule', taken: false }];
    const reqs = form.requirements
      ? form.requirements.split('\n').filter(Boolean)
      : [];
    addJob({
      title: form.title,
      category: effectiveCategory,
      pay: parseFloat(form.pay),
      payType: form.payType,
      location: form.location,
      description: form.description,
      urgent: form.urgent,
      estimatedHours: 2,
      requirements: reqs,
      slots,
    });
    setForm(INITIAL);
    setShowCustomCat(false);
    showToast({ icon: '🚀', title: 'Gig Posted!', message: 'Your gig is live — students can now apply!' });
    navigation.navigate('GigsMain');
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingBottom: 60 }}
        keyboardShouldPersistTaps="handled"
      >
        <LinearGradient colors={gradients.primary} style={[styles.header, { paddingTop: insets.top + 16 }]}>
          <Text style={styles.headerTitle}>Post a Gig</Text>
          <Text style={styles.headerSub}>Hire a motivated college student</Text>
        </LinearGradient>

        <View style={styles.form}>
          <Field label="Job Title *">
            <TextInput
              style={styles.input}
              placeholder="e.g. Lawn Mowing, Math Tutor..."
              placeholderTextColor={colors.textMuted}
              value={form.title}
              onChangeText={v => set('title', v)}
            />
          </Field>

          <Field label="Category *">
            <View style={styles.catGrid}>
              {CATS.map(cat => {
                const active = form.category === cat.id;
                return (
                  <TouchableOpacity
                    key={cat.id}
                    style={[styles.catChip, active && styles.catChipActive]}
                    onPress={() => {
                      haptic.selection();
                      set('category', cat.id);
                      setShowCustomCat(false);
                    }}
                  >
                    <Ionicons name={cat.ion} size={15} color={active ? '#fff' : colors.primary} style={styles.catChipIcon} />
                    <Text style={[styles.catChipText, active && styles.catChipTextActive]}>{cat.label}</Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={[styles.catChip, form.category === 'other' && styles.catChipActive]}
                onPress={() => {
                  haptic.selection();
                  set('category', 'other');
                  setShowCustomCat(true);
                }}
              >
                <Ionicons name="create" size={15} color={form.category === 'other' ? '#fff' : colors.primary} style={styles.catChipIcon} />
                <Text style={[styles.catChipText, form.category === 'other' && styles.catChipTextActive]}>Other</Text>
              </TouchableOpacity>
            </View>
            {showCustomCat && (
              <TextInput
                style={[styles.input, { marginTop: 10 }]}
                placeholder="Type your category name..."
                placeholderTextColor={colors.textMuted}
                value={form.customCategory}
                onChangeText={v => set('customCategory', v)}
              />
            )}
          </Field>

          <Field label="Pay *">
            <View style={styles.payRow}>
              <View style={styles.payInputWrap}>
                <Text style={styles.dollar}>$</Text>
                <TextInput
                  style={styles.payInput}
                  placeholder="0"
                  value={form.pay}
                  onChangeText={v => set('pay', v)}
                  keyboardType="numeric"
                  placeholderTextColor={colors.textMuted}
                />
              </View>
              {['flat', 'hourly'].map(t => (
                <TouchableOpacity
                  key={t}
                  style={[styles.payTypeBtn, form.payType === t && styles.payTypeBtnActive]}
                  onPress={() => { haptic.selection(); set('payType', t); }}
                >
                  <Text style={[styles.payTypeBtnText, form.payType === t && styles.payTypeBtnTextActive]}>
                    {t === 'flat' ? 'Flat' : '/hr'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </Field>

          <Field label="Location *">
            <LocationPicker
              value={form.location}
              onChange={v => set('location', v)}
            />
          </Field>

          <Field label="Description *">
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder="Describe the job in detail..."
              placeholderTextColor={colors.textMuted}
              value={form.description}
              onChangeText={v => set('description', v)}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
            />
          </Field>

          <Field label="Requirements (one per line)">
            <TextInput
              style={[styles.input, styles.textArea]}
              placeholder={'e.g. Must have a car\nExperience with power tools'}
              placeholderTextColor={colors.textMuted}
              value={form.requirements}
              onChangeText={v => set('requirements', v)}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </Field>

          <Field label="Available Times">
            <DateTimePicker
              slots={form.slots}
              onChange={slots => set('slots', slots)}
            />
          </Field>

          <TouchableOpacity
            style={[styles.urgentToggle, form.urgent && styles.urgentActive]}
            onPress={() => { haptic.light(); set('urgent', !form.urgent); }}
          >
            <Text style={styles.urgentToggleText}>
              {form.urgent ? 'Marked as Urgent — Needed ASAP' : 'Mark as Urgent (optional)'}
            </Text>
          </TouchableOpacity>

          {(!form.title || !effectiveCategory || !form.pay || !form.location || !form.description) && (
            <Text style={styles.validationNote}>* Fill in all required fields to post</Text>
          )}

          <TouchableOpacity onPress={handlePost} activeOpacity={0.85}>
            <LinearGradient
              colors={(!form.title || !effectiveCategory || !form.pay || !form.location || !form.description)
                ? ['#C4B5FD', '#A5B4FC']
                : gradients.primary}
              style={styles.submitBtn}
            >
              <Text style={styles.submitText}>Post Gig</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, children }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: 20, paddingBottom: 24 },
  headerTitle: { fontSize: 24, fontWeight: '900', color: '#fff', marginBottom: 4 },
  headerSub: { fontSize: 14, color: 'rgba(255,255,255,0.75)' },
  form: { padding: 20 },
  field: { marginBottom: 22 },
  fieldLabel: {
    fontSize: 12, fontWeight: '800', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8,
  },
  input: {
    backgroundColor: colors.surface, borderRadius: 14, padding: 14,
    fontSize: 15, color: colors.textPrimary,
    borderWidth: 1.5, borderColor: colors.border,
  },
  textArea: { minHeight: 96, lineHeight: 22 },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  catChip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 20, backgroundColor: colors.surface,
    borderWidth: 1.5, borderColor: colors.border,
    marginRight: 8, marginBottom: 8,
  },
  catChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  catChipIcon: { fontSize: 14, marginRight: 5 },
  catChipText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  catChipTextActive: { color: '#fff' },
  payRow: { flexDirection: 'row', alignItems: 'center' },
  payInputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: 14,
    borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: 14, flex: 1, height: 50, marginRight: 10,
  },
  dollar: { fontSize: 16, color: colors.textSecondary, marginRight: 4 },
  payInput: { flex: 1, fontSize: 16, color: colors.textPrimary },
  payTypeBtn: {
    paddingHorizontal: 16, paddingVertical: 12,
    borderRadius: 12, backgroundColor: colors.surface,
    borderWidth: 1.5, borderColor: colors.border, marginLeft: 6,
  },
  payTypeBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  payTypeBtnText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  payTypeBtnTextActive: { color: '#fff' },
  urgentToggle: {
    borderWidth: 1.5, borderColor: '#FCA5A5',
    borderRadius: 14, padding: 14, alignItems: 'center',
    marginBottom: 16, backgroundColor: colors.surface,
  },
  urgentActive: { backgroundColor: colors.urgentLight, borderColor: colors.urgent },
  urgentToggleText: { fontSize: 14, fontWeight: '700', color: colors.urgent },
  validationNote: { fontSize: 12, color: colors.textMuted, textAlign: 'center', marginBottom: 10 },
  submitBtn: { borderRadius: 16, paddingVertical: 18, alignItems: 'center' },
  submitText: { color: '#fff', fontSize: 17, fontWeight: '800' },
});
