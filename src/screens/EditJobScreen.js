import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, KeyboardAvoidingView, Platform, Alert, Keyboard,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useHaptic } from '../hooks/useHaptic';
import LocationPicker from '../components/LocationPicker';
import DateTimePicker from '../components/DateTimePicker';
import { colors, gradients } from '../theme';
import { CATEGORIES } from '../data/mockData';

const CATS = CATEGORIES.filter(c => c.id !== 'all');

export default function EditJobScreen({ route, navigation }) {
  const { jobId } = route.params;
  const { jobs, updateJob, deleteJob, posterBookings, clearAmendment } = useJobs();
  const { showToast } = useUser();
  const haptic = useHaptic();
  const insets = useSafeAreaInsets();

  const job = jobs.find(j => j.id === jobId);
  const isKnownCategory = job ? CATS.some(c => c.id === job.category) : false;

  const [form, setForm] = useState({
    title: job?.title || '',
    category: isKnownCategory ? job.category : 'other',
    customCategory: isKnownCategory ? '' : (job?.category || ''),
    pay: String(job?.pay || ''),
    payType: job?.payType || 'flat',
    location: job?.location || '',
    description: job?.description || '',
    requirements: (job?.requirements || []).join('\n'),
    urgent: job?.urgent || false,
    slots: job?.slots ? job.slots.map(s => ({ ...s })) : [],
  });
  const [showCustomCat, setShowCustomCat] = useState(!isKnownCategory && !!job?.category);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const effectiveCategory = form.category === 'other' ? form.customCategory : form.category;

  // Lock core terms once any booking is confirmed/in-progress
  const jobBookings = posterBookings.filter(b => b.jobId === jobId);
  const lockedBooking = jobBookings.find(b => ['confirmed','completed','verified'].includes(b.status));
  const isLocked = !!lockedBooking;
  const amendmentAccepted = isLocked && lockedBooking.amendmentStatus === 'accepted';
  const canEditCore = !isLocked || amendmentAccepted;

  if (!job) return null;

  const handleSave = async () => {
    Keyboard.dismiss();
    if (!form.title || !effectiveCategory || !form.pay || !form.location || !form.description) {
      haptic.error();
      return;
    }
    haptic.success();
    const reqs = form.requirements ? form.requirements.split('\n').filter(Boolean) : [];
    await updateJob(jobId, {
      title: form.title, category: effectiveCategory,
      pay: parseFloat(form.pay), payType: form.payType,
      location: form.location, description: form.description,
      urgent: form.urgent, requirements: reqs, slots: form.slots,
    });
    if (amendmentAccepted && lockedBooking) {
      await clearAmendment(lockedBooking.id);
    }
    showToast({ icon: '✏️', title: 'Gig Updated!', message: 'Your changes are live.' });
    navigation.goBack();
  };

  const handleDelete = () => {
    if (isLocked) {
      Alert.alert(
        'Cannot Delete',
        'Someone is actively working this gig. Complete or decline the booking before deleting.',
      );
      return;
    }
    Alert.alert(
      'Delete Gig?',
      `"${job.title}" will be removed and no one can book it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            haptic.heavy();
            await deleteJob(jobId);
            showToast({ icon: '🗑️', title: 'Gig Deleted', message: 'The listing has been removed.' });
            navigation.goBack();
          },
        },
      ]
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <LinearGradient colors={gradients.profile} style={[styles.header, { paddingTop: insets.top + 16 }]}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
              <Text style={styles.backText}>‹ Back</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleDelete} style={styles.deleteBtn}>
              <Text style={styles.deleteBtnText}>Delete</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.headerTitle}>Edit Gig ✏️</Text>
          <Text style={styles.headerSub}>{job.title}</Text>
        </LinearGradient>

        {isLocked && !amendmentAccepted && (
          <View style={styles.lockBanner}>
            <Text style={styles.lockIcon}>🔒</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.lockTitle}>Core Terms Locked</Text>
              <Text style={styles.lockDesc}>
                Pay, location, and time slots are locked — an earner has committed to this gig. Use "Request Change" in the Gigs tab to propose an update. Both parties must agree before core terms can change.
              </Text>
            </View>
          </View>
        )}
        {amendmentAccepted && (
          <View style={styles.amendBanner}>
            <Text style={styles.lockIcon}>✅</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.amendTitle}>Amendment Accepted</Text>
              <Text style={styles.lockDesc}>
                The earner approved your proposed change. Edit the terms below and save — this unlock is used once.
              </Text>
            </View>
          </View>
        )}

        <View style={styles.form}>
          <Field label="Job Title *">
            <TextInput
              style={styles.input} placeholder="e.g. Lawn Mowing, Math Tutor..."
              placeholderTextColor={colors.textMuted} value={form.title}
              onChangeText={v => set('title', v)}
            />
          </Field>

          <Field label="Category *">
            <View style={styles.catGrid}>
              {CATS.map(cat => {
                const active = form.category === cat.id;
                return (
                  <TouchableOpacity key={cat.id}
                    style={[styles.catChip, active && styles.catChipActive]}
                    onPress={() => { haptic.selection(); set('category', cat.id); setShowCustomCat(false); }}
                  >
                    <Text style={styles.catChipIcon}>{cat.icon}</Text>
                    <Text style={[styles.catChipText, active && styles.catChipTextActive]}>{cat.label}</Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={[styles.catChip, form.category === 'other' && styles.catChipActive]}
                onPress={() => { haptic.selection(); set('category', 'other'); setShowCustomCat(true); }}
              >
                <Text style={styles.catChipIcon}>✏️</Text>
                <Text style={[styles.catChipText, form.category === 'other' && styles.catChipTextActive]}>Other</Text>
              </TouchableOpacity>
            </View>
            {showCustomCat && (
              <TextInput style={[styles.input, { marginTop: 10 }]} placeholder="Type your category name..."
                placeholderTextColor={colors.textMuted} value={form.customCategory}
                onChangeText={v => set('customCategory', v)} />
            )}
          </Field>

          <Field label={`Pay *${isLocked && !canEditCore ? '  🔒' : ''}`}>
            <View style={[styles.payRow, !canEditCore && styles.lockedRow]}>
              <View style={styles.payInputWrap}>
                <Text style={styles.dollar}>$</Text>
                <TextInput
                  style={styles.payInput} placeholder="0" value={form.pay}
                  onChangeText={v => set('pay', v)} keyboardType="numeric"
                  placeholderTextColor={colors.textMuted} editable={canEditCore}
                />
              </View>
              {['flat', 'hourly'].map(t => (
                <TouchableOpacity key={t}
                  style={[styles.payTypeBtn, form.payType === t && styles.payTypeBtnActive, !canEditCore && styles.payTypeBtnLocked]}
                  onPress={() => { if (!canEditCore) return; haptic.selection(); set('payType', t); }}
                >
                  <Text style={[styles.payTypeBtnText, form.payType === t && styles.payTypeBtnTextActive]}>
                    {t === 'flat' ? 'Flat' : '/hr'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </Field>

          <Field label={`Location *${isLocked && !canEditCore ? '  🔒' : ''}`}>
            {canEditCore
              ? <LocationPicker value={form.location} onChange={v => set('location', v)} />
              : <View style={[styles.input, styles.lockedInput]}><Text style={styles.lockedValue}>{form.location}</Text></View>
            }
          </Field>

          <Field label="Description *">
            <TextInput style={[styles.input, styles.textArea]} multiline numberOfLines={4}
              textAlignVertical="top" placeholder="Describe the job..."
              placeholderTextColor={colors.textMuted} value={form.description}
              onChangeText={v => set('description', v)} />
          </Field>

          <Field label="Requirements (one per line)">
            <TextInput style={[styles.input, styles.textArea]} multiline numberOfLines={3}
              textAlignVertical="top" placeholder={'e.g. Must have a car\nExperience required'}
              placeholderTextColor={colors.textMuted} value={form.requirements}
              onChangeText={v => set('requirements', v)} />
          </Field>

          <Field label={`Available Times${isLocked && !canEditCore ? '  🔒' : ''}`}>
            {canEditCore
              ? <DateTimePicker slots={form.slots} onChange={slots => set('slots', slots)} />
              : (
                <View style={styles.lockedSlots}>
                  {form.slots.map(s => (
                    <View key={s.id} style={styles.lockedSlotTag}>
                      <Text style={styles.lockedSlotText}>📅 {s.label}</Text>
                    </View>
                  ))}
                </View>
              )
            }
          </Field>

          <TouchableOpacity
            style={[styles.urgentToggle, form.urgent && styles.urgentActive]}
            onPress={() => { haptic.light(); set('urgent', !form.urgent); }}
          >
            <Text style={styles.urgentToggleText}>
              {form.urgent ? '⚡ Marked as Urgent — Needed ASAP' : '⚡ Mark as Urgent (optional)'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={handleSave} activeOpacity={0.85}>
            <LinearGradient colors={gradients.profile} style={styles.submitBtn}>
              <Text style={styles.submitText}>Save Changes ✓</Text>
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
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  backBtn: { padding: 4 },
  backText: { color: 'rgba(255,255,255,0.85)', fontSize: 16, fontWeight: '700' },
  deleteBtn: { backgroundColor: 'rgba(239,68,68,0.2)', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 6 },
  deleteBtnText: { color: '#FCA5A5', fontSize: 14, fontWeight: '800' },
  headerTitle: { fontSize: 24, fontWeight: '900', color: '#fff', marginBottom: 4 },
  headerSub: { fontSize: 13, color: 'rgba(255,255,255,0.7)' },
  lockBanner: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: '#FFF7ED', margin: 16, marginBottom: 0,
    borderRadius: 14, padding: 14,
    borderWidth: 1.5, borderColor: '#FED7AA',
  },
  amendBanner: {
    flexDirection: 'row', alignItems: 'flex-start',
    backgroundColor: '#ECFDF5', margin: 16, marginBottom: 0,
    borderRadius: 14, padding: 14,
    borderWidth: 1.5, borderColor: '#6EE7B7',
  },
  lockIcon: { fontSize: 20, marginRight: 12, marginTop: 1 },
  lockTitle: { fontSize: 13, fontWeight: '800', color: '#D97706', marginBottom: 3 },
  amendTitle: { fontSize: 13, fontWeight: '800', color: '#059669', marginBottom: 3 },
  lockDesc: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  form: { padding: 20 },
  field: { marginBottom: 22 },
  fieldLabel: { fontSize: 12, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
  input: { backgroundColor: colors.surface, borderRadius: 14, padding: 14, fontSize: 15, color: colors.textPrimary, borderWidth: 1.5, borderColor: colors.border },
  textArea: { minHeight: 96, lineHeight: 22 },
  lockedInput: { opacity: 0.6 },
  lockedValue: { fontSize: 15, color: colors.textSecondary },
  lockedRow: { opacity: 0.6 },
  lockedSlots: { marginTop: 4 },
  lockedSlotTag: {
    backgroundColor: colors.surface, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 9, marginBottom: 6,
    borderWidth: 1.5, borderColor: colors.border, opacity: 0.7,
  },
  lockedSlotText: { fontSize: 13, color: colors.textSecondary },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  catChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border, marginRight: 8, marginBottom: 8 },
  catChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  catChipIcon: { fontSize: 14, marginRight: 5 },
  catChipText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  catChipTextActive: { color: '#fff' },
  payRow: { flexDirection: 'row', alignItems: 'center' },
  payInputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1.5, borderColor: colors.border, paddingHorizontal: 14, flex: 1, height: 50, marginRight: 10 },
  dollar: { fontSize: 16, color: colors.textSecondary, marginRight: 4 },
  payInput: { flex: 1, fontSize: 16, color: colors.textPrimary },
  payTypeBtn: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border, marginLeft: 6 },
  payTypeBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  payTypeBtnLocked: { opacity: 0.5 },
  payTypeBtnText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  payTypeBtnTextActive: { color: '#fff' },
  urgentToggle: { borderWidth: 1.5, borderColor: '#FCA5A5', borderRadius: 14, padding: 14, alignItems: 'center', marginBottom: 16, backgroundColor: colors.surface },
  urgentActive: { backgroundColor: colors.urgentLight, borderColor: colors.urgent },
  urgentToggleText: { fontSize: 14, fontWeight: '700', color: colors.urgent },
  submitBtn: { borderRadius: 16, paddingVertical: 18, alignItems: 'center' },
  submitText: { color: '#fff', fontSize: 17, fontWeight: '800' },
});
