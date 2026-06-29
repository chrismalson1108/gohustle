import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Image,
  StyleSheet, KeyboardAvoidingView, Platform, Alert, Keyboard, ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useJobs } from '../context/JobsContext';
import { useUser } from '../context/UserContext';
import { useAuth } from '../context/AuthContext';
import { useHaptic } from '../hooks/useHaptic';
import LocationPicker from '../components/LocationPicker';
import DateTimePicker from '../components/DateTimePicker';
import TagInput from '../components/TagInput';
import { pickImages, uploadImages } from '../lib/uploadImage';
import { findProhibited } from '../lib/contentFilter';
import { colors, gradients } from '../theme';
import { CATEGORIES } from '../data/mockData';

const CATS = CATEGORIES.filter(c => c.id !== 'all');
const RECURRENCE_OPTS = [
  { id: 'none', label: 'One-time' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'biweekly', label: 'Biweekly' },
  { id: 'monthly', label: 'Monthly' },
];

export default function EditJobScreen({ route, navigation }) {
  const { jobId } = route.params;
  const { jobs, updateJob, deleteJob, posterBookings, clearAmendment } = useJobs();
  const { showToast } = useUser();
  const { user } = useAuth();
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
    recurrence: job?.recurrence || 'none',
    tags: job?.tags || [],
    hazards: job?.hazards || [],
  });
  const [showCustomCat, setShowCustomCat] = useState(!isKnownCategory && !!job?.category);
  const [photos, setPhotos] = useState(job?.photos || []); // mix of remote URLs + new local URIs
  const [coords, setCoords] = useState(job?.lat != null ? { lat: job.lat, lng: job.lng } : null);
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const addPhotos = async () => {
    const res = await pickImages({ multiple: true });
    if (res.canceled) {
      if (res.denied) showToast({ icon: '⚠️', title: 'Photos access needed', message: 'Allow photo access in Settings to add photos.' });
      return;
    }
    setPhotos(prev => [...prev, ...res.uris].slice(0, 6));
  };
  const effectiveCategory = form.category === 'other' ? form.customCategory : form.category;

  // Lock core terms once any booking is confirmed/in-progress
  const jobBookings = posterBookings.filter(b => b.jobId === jobId);
  const lockedBooking = jobBookings.find(b => ['confirmed','completed','verified'].includes(b.status));
  const isLocked = !!lockedBooking;
  const amendmentAccepted = isLocked && lockedBooking.amendmentStatus === 'accepted';
  const canEditCore = !isLocked || amendmentAccepted;
  // Pay is special: once a booking is active there's an escrow hold authorized at
  // the agreed amount, and a Stripe hold cannot be re-priced in place. So pay/payType
  // stay locked even under an accepted amendment — changing them would desync the
  // money from the terms. To change pay, cancel the booking (which releases the hold)
  // and let the earner re-book at the new rate.
  const canEditPay = !isLocked;

  if (!job) return null;

  const handleSave = async () => {
    Keyboard.dismiss();
    if (!form.title || !effectiveCategory || !form.pay || !form.location || !form.description) {
      haptic.error();
      return;
    }
    if (findProhibited(`${form.title} ${form.description}`)) {
      haptic.error();
      showToast({ icon: '⚠️', title: 'Check your wording', message: "This gig contains content that isn't allowed. Please edit it." });
      return;
    }
    setSaving(true);
    // Upload any newly added local photos; keep already-hosted URLs in order.
    let finalPhotos = photos;
    try {
      const toUpload = photos.filter(u => !u.startsWith('http'));
      if (toUpload.length) {
        const uploaded = await uploadImages({ uris: toUpload, bucket: 'job-photos', userId: user.id });
        let idx = 0;
        finalPhotos = photos.map(u => (u.startsWith('http') ? u : uploaded[idx++]));
      }
    } catch (e) {
      setSaving(false);
      showToast({ icon: '⚠️', title: 'Photo upload failed', message: e.message || 'Please try again.' });
      return;
    }
    haptic.success();
    const reqs = form.requirements ? form.requirements.split('\n').filter(Boolean) : [];
    await updateJob(jobId, {
      title: form.title, category: effectiveCategory,
      pay: parseFloat(form.pay), payType: form.payType,
      location: form.location, description: form.description,
      urgent: form.urgent, requirements: reqs, slots: form.slots,
      photos: finalPhotos,
      recurrence: form.recurrence,
      tags: form.tags,
      hazards: form.hazards,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
    });
    if (amendmentAccepted && lockedBooking) {
      await clearAmendment(lockedBooking.id);
    }
    setSaving(false);
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
          <Text style={styles.headerTitle}>Edit Gig</Text>
          <Text style={styles.headerSub}>{job.title}</Text>
        </LinearGradient>

        {isLocked && !amendmentAccepted && (
          <View style={styles.lockBanner}>
            <Ionicons name="lock-closed" size={20} color="#D97706" style={styles.lockIcon} />
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
            <Ionicons name="checkmark-circle" size={20} color={colors.success} style={styles.lockIcon} />
            <View style={{ flex: 1 }}>
              <Text style={styles.amendTitle}>Amendment Accepted</Text>
              <Text style={styles.lockDesc}>
                The earner approved your proposed change. Edit the terms below and save — this unlock is used once. Pay stays locked: it's backed by an escrow hold. To change pay, cancel the booking (releasing the hold) and have the earner re-book.
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
                    <Ionicons name={cat.ion} size={15} color={active ? '#fff' : colors.primary} style={styles.catChipIcon} />
                    <Text style={[styles.catChipText, active && styles.catChipTextActive]}>{cat.label}</Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={[styles.catChip, form.category === 'other' && styles.catChipActive]}
                onPress={() => { haptic.selection(); set('category', 'other'); setShowCustomCat(true); }}
              >
                <Ionicons name="create" size={15} color={form.category === 'other' ? '#fff' : colors.primary} style={styles.catChipIcon} />
                <Text style={[styles.catChipText, form.category === 'other' && styles.catChipTextActive]}>Other</Text>
              </TouchableOpacity>
            </View>
            {showCustomCat && (
              <TextInput style={[styles.input, { marginTop: 10 }]} placeholder="Type your category name..."
                placeholderTextColor={colors.textMuted} value={form.customCategory}
                onChangeText={v => set('customCategory', v)} />
            )}
          </Field>

          <Field label="Tags (optional)">
            <TagInput value={form.tags} onChange={v => set('tags', v)} />
          </Field>

          <Field label="Safety notes / hazards (optional)">
            <TagInput value={form.hazards} onChange={v => set('hazards', v)} placeholder="e.g. dog on site, uneven ground, fragile items" />
          </Field>

          <Field label={`Pay *${isLocked && !canEditPay ? '  (locked)' : ''}`}>
            <View style={[styles.payRow, !canEditPay && styles.lockedRow]}>
              <View style={styles.payInputWrap}>
                <Text style={styles.dollar}>$</Text>
                <TextInput
                  style={styles.payInput} placeholder="0" value={form.pay}
                  onChangeText={v => set('pay', v)} keyboardType="numeric"
                  placeholderTextColor={colors.textMuted} editable={canEditPay}
                />
              </View>
              {['flat', 'hourly'].map(t => (
                <TouchableOpacity key={t}
                  style={[styles.payTypeBtn, form.payType === t && styles.payTypeBtnActive, !canEditPay && styles.payTypeBtnLocked]}
                  onPress={() => { if (!canEditPay) return; haptic.selection(); set('payType', t); }}
                >
                  <Text style={[styles.payTypeBtnText, form.payType === t && styles.payTypeBtnTextActive]}>
                    {t === 'flat' ? 'Flat' : '/hr'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </Field>

          <Field label={`Location *${isLocked && !canEditCore ? '  (locked)' : ''}`}>
            {canEditCore
              ? <LocationPicker value={form.location} onChange={(v, c) => { set('location', v); setCoords(c); }} />
              : <View style={[styles.input, styles.lockedInput]}><Text style={styles.lockedValue}>{form.location}</Text></View>
            }
          </Field>

          <Field label="Description *">
            <TextInput style={[styles.input, styles.textArea]} multiline numberOfLines={4}
              textAlignVertical="top" placeholder="Describe the job..."
              placeholderTextColor={colors.textMuted} value={form.description}
              onChangeText={v => set('description', v)} />
          </Field>

          <Field label="Photos (optional)">
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {photos.map((u, i) => (
                <View key={i} style={styles.thumbWrap}>
                  <Image source={{ uri: u }} style={styles.thumb} />
                  <TouchableOpacity style={styles.thumbRemove} onPress={() => setPhotos(prev => prev.filter((_, idx) => idx !== i))}>
                    <Ionicons name="close" size={13} color="#fff" />
                  </TouchableOpacity>
                </View>
              ))}
              {photos.length < 6 && (
                <TouchableOpacity style={styles.addTile} onPress={addPhotos}>
                  <Ionicons name="camera-outline" size={24} color={colors.primary} />
                  <Text style={styles.addTileText}>Add</Text>
                </TouchableOpacity>
              )}
            </ScrollView>
          </Field>

          <Field label="Requirements (one per line)">
            <TextInput style={[styles.input, styles.textArea]} multiline numberOfLines={3}
              textAlignVertical="top" placeholder={'e.g. Must have a car\nExperience required'}
              placeholderTextColor={colors.textMuted} value={form.requirements}
              onChangeText={v => set('requirements', v)} />
          </Field>

          <Field label={`Available Times${isLocked && !canEditCore ? '  (locked)' : ''}`}>
            {canEditCore
              ? <DateTimePicker slots={form.slots} onChange={slots => set('slots', slots)} />
              : (
                <View style={styles.lockedSlots}>
                  {form.slots.map(s => (
                    <View key={s.id} style={styles.lockedSlotTag}>
                      <Text style={styles.lockedSlotText}>{s.label}</Text>
                    </View>
                  ))}
                </View>
              )
            }
          </Field>

          <Field label="Repeats">
            <View style={styles.catGrid}>
              {RECURRENCE_OPTS.map(opt => {
                const active = form.recurrence === opt.id;
                return (
                  <TouchableOpacity key={opt.id}
                    style={[styles.catChip, active && styles.catChipActive]}
                    onPress={() => { haptic.selection(); set('recurrence', opt.id); }}
                  >
                    <Text style={[styles.catChipText, active && styles.catChipTextActive]}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </Field>

          <TouchableOpacity
            style={[styles.urgentToggle, form.urgent && styles.urgentActive]}
            onPress={() => { haptic.light(); set('urgent', !form.urgent); }}
          >
            <Text style={styles.urgentToggleText}>
              {form.urgent ? 'Marked as Urgent — Needed ASAP' : 'Mark as Urgent (optional)'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={handleSave} activeOpacity={0.85} disabled={saving}>
            <LinearGradient colors={gradients.profile} style={styles.submitBtn}>
              {saving
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.submitText}>Save Changes ✓</Text>}
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
  thumbWrap: { marginRight: 10 },
  thumb: { width: 84, height: 84, borderRadius: 12, backgroundColor: colors.border },
  thumbRemove: {
    position: 'absolute', top: -6, right: -6,
    width: 22, height: 22, borderRadius: 11, backgroundColor: colors.urgent,
    alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff',
  },
  addTile: {
    width: 84, height: 84, borderRadius: 12, borderWidth: 1.5, borderColor: colors.primary,
    borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface,
  },
  addTileText: { fontSize: 11, fontWeight: '700', color: colors.primary, marginTop: 2 },
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
